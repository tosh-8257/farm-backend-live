import {
  Injectable,
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { PaystackService } from '../paystack/paystack.service';
import { IvorypayService } from '../ivorypay/ivorypay.service';
import { generateTxReference } from '../common/utils/reference.util';
import { PaymentMethod } from '@prisma/client';
import { CacheService } from '../common/cache/cache.service';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { CurrencyConversionService } from '../currency/currency-conversion.service';
import { HIDDEN_TRANSACTION_HISTORY_STATUSES } from '../common/utils/hidden-transaction-history-statuses';
import { NowpaymentsService } from '../nowpayments/nowpayments.service';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private prisma: PrismaService,
    private cfg: ConfigService,
    private ivorypay: IvorypayService,
    private paystack: PaystackService,
    private cache: CacheService,
    private currencyConversionService: CurrencyConversionService,
    private readonly nowpayments: NowpaymentsService,
  ) {}

  async initiateDeposit(
    userId: string,
    dto: {
      amount_fiat: number;
      currency: string;
      paymentMethod?: string;
      phone?: string;
      email?: string;
      crypto?: string;
      chain?: string;
      walletAddress?: string;
      callbackUrl?: string;
      merchantQrCheckout?: boolean;
    },
    ctx?: { deviceRisk?: number; ip?: string; country?: string },
  ) {
    const supportedPaymentMethods: PaymentMethod[] = [
      'CARD',
      'MOBILE_MONEY',
      'CRYPTO',
      'BANK_TRANSFER',
    ];
    const rawPaymentMethod = (dto.paymentMethod || 'CARD').toUpperCase();
    if (!supportedPaymentMethods.includes(rawPaymentMethod as PaymentMethod)) {
      throw new BadRequestException(
        `Unsupported payment method ${dto.paymentMethod}`,
      );
    }
    const paymentMethod = rawPaymentMethod as PaymentMethod;
    if (
      paymentMethod === 'BANK_TRANSFER' &&
      dto.currency.trim().toUpperCase() !== 'KES'
    ) {
      throw new BadRequestException('Paystack Pesalink deposits must use KES.');
    }

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: {
        email: true,
        phone: true,
        first_name: true,
        last_name: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const reference =
      paymentMethod === 'CRYPTO' ? randomUUID() : generateTxReference();
    const callbackUrl = dto.callbackUrl
      ? `${dto.callbackUrl}${dto.callbackUrl.includes('?') ? '&' : '?'}reference=${encodeURIComponent(reference)}${
          paymentMethod === 'CRYPTO' && dto.merchantQrCheckout
            ? `&farm_reference=${encodeURIComponent(reference)}`
            : ''
        }`
      : undefined;
    const rate = await this.getExchangeRate(dto.currency, 'FARM');
    const amount_farm = dto.amount_fiat / rate;

    const fraud = await this.assessFraudRisk(userId, {
      amount_fiat: dto.amount_fiat,
      currency: dto.currency,
      ip: ctx?.ip || '',
      deviceRisk: ctx?.deviceRisk,
      country: ctx?.country,
    });
    if (fraud.block) {
      // Record the reason and full fraud object for investigation
      await this.prisma.audit_logs.create({
        data: {
          user_id: userId,
          action: 'deposit_blocked',
          entity_type: 'transaction',
          entity_id: null,
          new_values: { reason: fraud.reason, details: fraud },
        },
      });
      await this.prisma.security_events.create({
        data: {
          user_id: userId,
          event_type: 'fraud_score_high',
          description: `Blocked deposit attempt: ${fraud.reason} | ${JSON.stringify(fraud)}`,
          severity: 'high',
        },
      });

      this.logger.warn(
        `Deposit blocked for user=${userId} reference=${reference} reason=${fraud.reason} details=${JSON.stringify(fraud)}`,
      );

      // Provide a more informative error to the caller while avoiding leaking
      // sensitive internal data. Include the rule/reason id so support can act.
      const reasonLabel =
        typeof fraud.reason === 'string' ? fraud.reason : 'unknown_reason';
      throw new BadRequestException(
        `Deposit blocked by fraud protection: ${reasonLabel}`,
      );
    }

    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: userId, is_active: true },
    });

    if (paymentMethod === 'MOBILE_MONEY') {
      const phone =
        dto.phone || (dto.merchantQrCheckout ? undefined : user.phone);
      if (!phone && !dto.merchantQrCheckout) {
        throw new BadRequestException(
          'Phone number is required for mobile money deposits',
        );
      }

      // Validate phone format: Paystack mobile-money requires international format (+country code)
      if (phone && !phone.startsWith('+')) {
        this.logger.warn(
          `Mobile-money phone not in international format: ${phone}. Expected format: +254XXXXXXXXX`,
        );
      }

      const response = await this.paystack.initializePayment({
        email: dto.email?.trim() || user.email || `${user.phone}@farm.app`,
        amount: dto.amount_fiat,
        currency: dto.currency,
        reference,
        channels: ['mobile_money'],
        callback_url: callbackUrl || 'https://farmapp.africa/payment-callback',
        ...(phone ? { phone } : {}),
        metadata: {
          user_id: userId,
          currency: dto.currency,
        },
      });

      // No wallet credit occurs during deposit initiation.
      // Wallet balance must only be updated after a successful Paystack webhook.
      const tx = await this.prisma.transactions.create({
        data: {
          transaction_reference: reference,
          receiver_wallet_id: wallet?.id,
          transaction_type: 'deposit',
          status: 'pending',
          amount: amount_farm,
          fee: 0,
          net_amount: amount_farm,
          currency: 'FARM',
          description: `Mobile money deposit via Paystack (${dto.currency} ${dto.amount_fiat})`,
          metadata: {
            provider: 'paystack',
            amount_fiat: dto.amount_fiat,
            currency_fiat: dto.currency,
            exchange_rate: rate,
            user_id: userId,
            device_risk: ctx?.deviceRisk ?? null,
            ip: ctx?.ip ?? null,
            payment_method: 'MOBILE_MONEY',
          },
        },
      });

      this.logger.log(
        `initiateDeposit: created Paystack mobile-money transaction id=${tx.id} reference=${reference} amount_farm=${amount_farm}`,
      );

      await this.prisma.audit_logs.create({
        data: {
          user_id: userId,
          action: 'deposit_initiated',
          entity_type: 'transaction',
          entity_id: tx.id,
          new_values: { reference, amount_fiat: dto.amount_fiat, amount_farm },
        },
      });

      await this.prisma.deposit.create({
        data: {
          userId,
          amount: amount_farm,
          fee: 0,
          total: amount_farm,
          currency: 'FARM',
          paymentMethod: 'MOBILE_MONEY',
          provider: 'paystack',
          reference,
          status: 'PENDING',
        },
      });

      return {
        data: {
          provider: 'PAYSTACK',
          reference,
          payment_url: response.authorization_url || response.authorizationUrl,
          authorization_url:
            response.authorization_url || response.authorizationUrl,
        },
        message: 'Mobile money deposit initiated via Paystack checkout',
      };
    }

    if (paymentMethod === 'CRYPTO') {
      const email = dto.email?.trim() || user.email?.trim();
      if (!email) {
        throw new BadRequestException(
          'An email address is required for crypto merchant checkout',
        );
      }
      const crypto = (dto.crypto || 'usdttrc20').trim().toLowerCase();
      const currencies = await this.nowpayments.getAvailableCurrencies();
      if (!currencies.includes(crypto)) {
        throw new BadRequestException(
          'The selected cryptocurrency is not currently available',
        );
      }

      const currentRate = await this.currencyConversionService.getCurrentRate();
      const farmToUsdRate = Number(currentRate.farm_usd_rate);
      if (!Number.isFinite(farmToUsdRate) || farmToUsdRate <= 0) {
        throw new BadRequestException(
          'The FARM/USD conversion rate is unavailable',
        );
      }
      const amountUsd = Number((amount_farm * farmToUsdRate).toFixed(2));
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
        throw new BadRequestException(
          'The deposit amount is too small to convert to a positive USD amount',
        );
      }
      const usdToFarmRate = Number((1 / farmToUsdRate).toFixed(8));

      const payment = await this.nowpayments.createInvoice({
        priceAmount: amountUsd,
        priceCurrency: 'usd',
        payCurrency: crypto,
        orderId: reference,
        description: `FARM merchant crypto payment ${reference}`,
        successUrl: callbackUrl,
        cancelUrl: callbackUrl,
      });
      const providerRef = payment.invoice_id;

      const tx = await this.prisma.transactions.create({
        data: {
          transaction_reference: reference,
          receiver_wallet_id: wallet?.id,
          transaction_type: 'deposit',
          status: 'pending',
          amount: amount_farm,
          fee: 0,
          net_amount: amount_farm,
          currency: 'FARM',
          description: `Crypto merchant checkout via NOWPayments (${amount_farm} FARM -> ${amountUsd} USD)`,
          metadata: {
            provider: 'nowpayments',
            provider_ref: providerRef,
            nowpayments_invoice_id: providerRef,
            order_id: reference,
            pay_currency: crypto,
            amount_farm,
            amount_usd: amountUsd,
            amount_fiat: amountUsd,
            farm_to_usd_rate: farmToUsdRate,
            usd_to_farm_rate: usdToFarmRate,
            currency_fiat: 'USD',
            exchange_rate: rate,
            user_id: userId,
            device_risk: ctx?.deviceRisk ?? null,
            ip: ctx?.ip ?? null,
            payment_method: 'CRYPTO',
            crypto,
            chain: dto.chain ?? null,
          },
        },
      });

      this.logger.log(
        `initiateDeposit: created NOWPayments crypto invoice transaction id=${tx.id} reference=${reference} amount_farm=${amount_farm}`,
      );

      await this.prisma.audit_logs.create({
        data: {
          user_id: userId,
          action: 'deposit_initiated',
          entity_type: 'transaction',
          entity_id: tx.id,
          new_values: {
            reference,
            provider: 'nowpayments',
            amount_fiat: dto.amount_fiat,
            amount_farm,
          },
        },
      });

      await this.prisma.deposit.create({
        data: {
          userId,
          amount: amount_farm,
          fee: 0,
          total: amount_farm,
          currency: 'FARM',
          paymentMethod: 'CRYPTO',
          provider: 'nowpayments',
          reference,
          providerRef,
          status: 'PENDING',
        },
      });

      return {
        data: {
          provider: 'NOWPAYMENTS',
          reference,
          invoice_id: providerRef,
          payment_link: payment.invoice_url,
          checkout_url: payment.invoice_url,
          checkoutUrl: payment.invoice_url,
        },
        message: 'Crypto merchant checkout initiated via NOWPayments',
      };
    }

    if (paymentMethod === 'CARD') {
      const response = await this.paystack.initializePayment({
        email: user.email || `${user.phone}@farm.app`,
        amount: dto.amount_fiat,
        currency: dto.currency,
        reference,
        channels: ['card', 'mobile_money'],
        callback_url: callbackUrl || 'https://farmapp.africa/payment-callback',
        phone: dto.phone || user.phone || undefined,
        metadata: {
          provider: 'paystack',
          amount_fiat: dto.amount_fiat,
          currency_fiat: dto.currency,
          exchange_rate: rate,
          user_id: userId,
          device_risk: ctx?.deviceRisk ?? null,
          ip: ctx?.ip ?? null,
          payment_method: paymentMethod,
        },
      });

      const tx = await this.prisma.transactions.create({
        data: {
          transaction_reference: reference,
          receiver_wallet_id: wallet?.id,
          transaction_type: 'deposit',
          status: 'pending',
          amount: amount_farm,
          fee: 0,
          net_amount: amount_farm,
          currency: 'FARM',
          description: `Card deposit via Paystack (${dto.currency} ${dto.amount_fiat})`,
          metadata: {
            provider: 'paystack',
            amount_fiat: dto.amount_fiat,
            currency_fiat: dto.currency,
            exchange_rate: rate,
            user_id: userId,
            device_risk: ctx?.deviceRisk ?? null,
            ip: ctx?.ip ?? null,
            payment_method: paymentMethod,
          },
        },
      });

      this.logger.log(
        `initiateDeposit: created Paystack card transaction id=${tx.id} reference=${reference} amount_farm=${amount_farm}`,
      );

      await this.prisma.audit_logs.create({
        data: {
          user_id: userId,
          action: 'deposit_initiated',
          entity_type: 'transaction',
          entity_id: tx.id,
          new_values: { reference, amount_fiat: dto.amount_fiat, amount_farm },
        },
      });

      await this.prisma.deposit.create({
        data: {
          userId,
          amount: amount_farm,
          fee: 0,
          total: amount_farm,
          currency: 'FARM',
          paymentMethod,
          provider: 'paystack',
          reference,
          status: 'PENDING',
        },
      });

      return {
        data: {
          provider: 'PAYSTACK',
          reference,
          payment_url: response.authorization_url || response.authorizationUrl,
          authorization_url:
            response.authorization_url || response.authorizationUrl,
        },
        message: 'Card deposit initiated via Paystack checkout',
      };
    }

    if (paymentMethod === 'BANK_TRANSFER') {
      const response = await this.paystack.initializePayment({
        email: user.email || `${user.phone}@farm.app`,
        amount: dto.amount_fiat,
        currency: dto.currency,
        reference,
        channels: ['bank'],
        callback_url: callbackUrl || 'https://farmapp.africa/payment-callback',
        metadata: {
          provider: 'paystack',
          amount_fiat: dto.amount_fiat,
          currency_fiat: dto.currency,
          exchange_rate: rate,
          user_id: userId,
          device_risk: ctx?.deviceRisk ?? null,
          ip: ctx?.ip ?? null,
          payment_method: paymentMethod,
        },
      });

      const tx = await this.prisma.transactions.create({
        data: {
          transaction_reference: reference,
          receiver_wallet_id: wallet?.id,
          transaction_type: 'deposit',
          status: 'pending',
          amount: amount_farm,
          fee: 0,
          net_amount: amount_farm,
          currency: 'FARM',
          description: `Bank transfer deposit via Paystack (${dto.currency} ${dto.amount_fiat})`,
          metadata: {
            provider: 'paystack',
            amount_fiat: dto.amount_fiat,
            currency_fiat: dto.currency,
            exchange_rate: rate,
            user_id: userId,
            device_risk: ctx?.deviceRisk ?? null,
            ip: ctx?.ip ?? null,
            payment_method: paymentMethod,
          },
        },
      });

      this.logger.log(
        `initiateDeposit: created Paystack bank transfer transaction id=${tx.id} reference=${reference} amount_farm=${amount_farm}`,
      );

      await this.prisma.audit_logs.create({
        data: {
          user_id: userId,
          action: 'deposit_initiated',
          entity_type: 'transaction',
          entity_id: tx.id,
          new_values: { reference, amount_fiat: dto.amount_fiat, amount_farm },
        },
      });

      await this.prisma.deposit.create({
        data: {
          userId,
          amount: amount_farm,
          fee: 0,
          total: amount_farm,
          currency: 'FARM',
          paymentMethod,
          provider: 'paystack',
          reference,
          status: 'PENDING',
        },
      });

      return {
        data: {
          provider: 'PAYSTACK',
          reference,
          payment_url: response.authorization_url || response.authorizationUrl,
          authorization_url:
            response.authorization_url || response.authorizationUrl,
          access_code: response.access_code,
        },
        message: 'Bank transfer deposit initiated via Paystack checkout',
      };
    }

    throw new BadRequestException(
      `Unsupported payment method ${paymentMethod}`,
    );
  }

  async getCryptoPaymentOptions() {
    const currencies = await this.nowpayments.getAvailableCurrencies();
    const tokens = currencies.map((currency) => currency.toUpperCase());
    const options = tokens.map((token) => ({
      token,
      network: token,
      networkName: token,
    }));
    return { success: true, data: { tokens, options } };
  }

  // `processSuccessfulPayment` removed: paystack webhook handling is centralized
  // in `WebhookService` with queued processing. Wallet credits and transaction
  // finalization should be performed by the webhook processing flow.
  //
  // `requestWithdrawal` removed: use WithdrawService.createWithdrawal() instead.
  // This method incorrectly debited wallets immediately instead of locking funds.
  // Correct flow: WithdrawService locks funds → webhook finalizes transaction.

  async getExchangeRate(from: string, to: string): Promise<number> {
    const fromCode = from.toUpperCase();
    const toCode = to.toUpperCase();
    if (fromCode === toCode) return 1;

    const cacheKey = `exchange-rate:${fromCode}:${toCode}`;
    const cached = await this.cache.cacheGet<number>(cacheKey);
    if (cached !== null && cached !== undefined) return cached;

    const directRate = await this.prisma.exchange_rates.findFirst({
      where: { base_currency: fromCode, target_currency: toCode },
      orderBy: { fetched_at: 'desc' },
    });
    if (directRate) {
      const rate = Number(directRate.rate);
      await this.cache.cacheSet(cacheKey, rate, 300);
      return rate;
    }

    const reverseRate = await this.prisma.exchange_rates.findFirst({
      where: { base_currency: toCode, target_currency: fromCode },
      orderBy: { fetched_at: 'desc' },
    });
    if (reverseRate && Number(reverseRate.rate) !== 0) {
      const rate = 1 / Number(reverseRate.rate);
      await this.cache.cacheSet(cacheKey, rate, 300);
      return rate;
    }

    await this.cache.cacheSet(cacheKey, 1, 300);
    return 1;
  }

  // Simple fraud assessment: velocity and amount thresholds.
  private async assessFraudRisk(
    userId: string,
    ctx: {
      amount_fiat: number;
      currency: string;
      ip?: string;
      deviceRisk?: number;
      country?: string;
    },
  ) {
    // Load configurable thresholds from system_settings
    const keys = [
      'fraud.amount_threshold',
      'fraud.velocity_limit',
      'fraud.max_daily_amount',
    ];
    const settings = await this.prisma.system_settings.findMany({
      where: { setting_key: { in: keys } },
    });
    const getSetting = (k: string) => {
      const s = settings.find((x: any) => x.setting_key === k);
      if (!s || s.setting_value == null) return null;
      // Try parse JSON then number
      try {
        return JSON.parse(s.setting_value);
      } catch {
        /* ignore */
      }
      const n = Number(s.setting_value);
      return Number.isFinite(n) ? n : s.setting_value;
    };

    const amountThreshold = Number(
      getSetting('fraud.amount_threshold') ?? 5000,
    );
    const velocityLimit = Number(getSetting('fraud.velocity_limit') ?? 5);
    const maxDailyAmount = Number(
      getSetting('fraud.max_daily_amount') ?? 20000,
    );

    // Count recent deposits by this user in the last 1 hour
    const oneHourAgo = new Date(Date.now() - 1000 * 60 * 60);
    const recent = await this.prisma.transactions.count({
      where: {
        transaction_type: 'deposit',
        created_at: { gte: oneHourAgo },
        AND: [{ metadata: { path: ['user_id'], equals: userId } as any }],
      },
    });

    // Sum of today's deposits for max daily check
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todays = await this.prisma.transactions.aggregate({
      _sum: { amount: true },
      where: {
        transaction_type: 'deposit',
        created_at: { gte: startOfDay },
        AND: [{ metadata: { path: ['user_id'], equals: userId } as any }],
      },
    });
    const todaysSum = Number((todays._sum as any)?.amount ?? 0);

    // Apply system settings checks first
    if (ctx.amount_fiat > amountThreshold) {
      return {
        block: true,
        reason: 'amount_exceeds_threshold',
        threshold: amountThreshold,
      };
    }
    if (recent >= velocityLimit) {
      // High velocity deposits: treat as a challenge (require review) rather than
      // an outright block to avoid rejecting legitimate users who make multiple
      // small deposits in quick succession (e.g., during testing).
      return {
        block: false,
        challenge: true,
        reason: 'high_velocity',
        limit: velocityLimit,
      };
    }
    if (todaysSum + ctx.amount_fiat > maxDailyAmount) {
      return { block: true, reason: 'daily_limit_exceeded', maxDailyAmount };
    }

    // Load rule file if present and evaluate rules in priority order
    try {
      const rulesPath = path.join(process.cwd(), 'fraud.rules.json');
      if (fs.existsSync(rulesPath)) {
        const raw = fs.readFileSync(rulesPath, 'utf8');
        const rules = JSON.parse(raw) as any[];
        // sort by priority desc
        rules.sort((a: any, b: any) => (b.priority || 0) - (a.priority || 0));
        for (const r of rules) {
          // skip rules that don't apply by amount range
          if (r.min_amount && ctx.amount_fiat < r.min_amount) continue;
          if (r.max_amount && ctx.amount_fiat > r.max_amount) continue;

          // country check - requires ctx.country in metadata in future
          if (r.countries && Array.isArray(r.countries)) {
            const country = (ctx as any).country;
            if (!country) continue;
            if (r.countries.indexOf(country) === -1) continue;
          }

          // ip prefix matching
          if (r.ip_prefixes && Array.isArray(r.ip_prefixes) && ctx.ip) {
            let matched = false;
            for (const pfx of r.ip_prefixes) {
              if (ctx.ip.startsWith(pfx)) {
                matched = true;
                break;
              }
            }
            if (!matched) continue;
          }

          // device risk
          if (r.device_risk_threshold) {
            const dv = Number((ctx as any).deviceRisk || 0);
            if (dv < Number(r.device_risk_threshold)) continue;
          }

          // matched
          if (r.action === 'block')
            return { block: true, reason: r.reason || r.id, rule: r.id };
          if (r.action === 'challenge')
            return {
              block: false,
              challenge: true,
              reason: r.reason || r.id,
              rule: r.id,
            };
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `Failed to evaluate fraud.rules: ${err?.message ?? String(err)}`,
      );
    }

    return { block: false };
  }

  async getDepositHistory(userId: string) {
    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: userId },
    });
    const items = await this.prisma.transactions.findMany({
      where: {
        transaction_type: 'deposit',
        receiver_wallet_id: wallet?.id,
        status: { notIn: HIDDEN_TRANSACTION_HISTORY_STATUSES },
      },
      orderBy: { created_at: 'desc' },
    });
    return { data: items.map((t) => ({ ...t, amount: Number(t.amount) })) };
  }

  async getWithdrawalHistory(userId: string) {
    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: userId },
    });
    const items = await this.prisma.transactions.findMany({
      where: {
        transaction_type: 'withdrawal',
        sender_wallet_id: wallet?.id,
        status: { notIn: HIDDEN_TRANSACTION_HISTORY_STATUSES },
      },
      orderBy: { created_at: 'desc' },
    });
    return {
      data: items.map((t) => {
        const meta = (t.metadata as any) ?? {};
        const status = (t.status ?? 'UNKNOWN').toUpperCase();
        return {
          ...t,
          amount: Number(t.amount),
          // Hoist metadata fields to top level so the Flutter widget can read them
          method: meta.method ?? 'BANK',
          status: t.status?.toLowerCase() === 'completed' ? 'SUCCESS' : status,
        };
      }),
    };
  }
}
