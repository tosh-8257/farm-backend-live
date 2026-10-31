// src/withdraw/withdraw.service.ts
import {
  Injectable,
  BadGatewayException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { FeesService } from '../fees/fees.service';
import { feeFor } from '../fees/fee-defaults';
import { PrismaService } from '../database/prisma.service';
import { AuthService } from '../auth/auth.service';
import { SecurityService } from '../security/security.service';
import { PaystackService } from '../paystack/paystack.service';
import { CreateWithdrawDto } from './dto/create-withdraw.dto';
import { v4 as uuidv4 } from 'uuid';
import { CacheService } from '../common/cache/cache.service';
import { assertResourceAccess } from '../common/utils/access-control.util';
import { NotificationsService } from '../notifications/notifications.service';
import { CurrencyConversionService } from '../currency/currency-conversion.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { PaystackTransferInitiationError } from '../paystack/paystack.service';
import { Cron } from '@nestjs/schedule';
import { NowpaymentsService } from '../nowpayments/nowpayments.service';

const MIN_NOWPAYMENTS_CRYPTO_WITHDRAWAL_USD = 2;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Per-user rolling 24h withdrawal limits (all methods combined). 0 disables a limit. */
export function withdrawalDailyLimits() {
  return {
    maxCount: envNumber('WITHDRAWAL_DAILY_MAX_COUNT', 5),
    maxAmount: envNumber('WITHDRAWAL_DAILY_MAX_AMOUNT', 1_000_000),
  };
}

@Injectable()
export class WithdrawService {
  private readonly logger = new Logger(WithdrawService.name);
  private reconcilingPaystackWithdrawals = false;
  private reconcilingNowpaymentsPayouts = false;

  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
    private securityService: SecurityService,
    private paystack: PaystackService,
    private cache: CacheService,
    private notificationsService: NotificationsService,
    private readonly currencyConversionService: CurrencyConversionService,
    private readonly websocket: WebsocketGateway,
    private readonly nowpayments: NowpaymentsService,
    @Optional() private readonly fees?: FeesService,
  ) {}

  /**
   * @param opts.preAuthorized set only by trusted server code that has already
   *   authorised the request another way (a live business API key with the
   *   payout scope). It skips the PIN/biometric step and nothing else: the
   *   atomic balance lock, daily limits, address validation and automatic
   *   payout are identical.
   */
  async createWithdrawal(
    userId: string,
    dto: CreateWithdrawDto,
    opts: { preAuthorized?: string } = {},
  ) {
    const requestedMethod: string = dto.method;
    if (requestedMethod === 'CRYPTO') {
      return this.createNowpaymentsCryptoWithdrawal(userId, dto, opts);
    }

    // Support biometric-based authorization: verify device fingerprint server-side
    if (opts.preAuthorized) {
      this.logger.log(`Withdrawal pre-authorised by ${opts.preAuthorized}`);
    } else if (dto.biometric_auth) {
      const deviceFingerprint =
        dto.device_fingerprint || (dto as any).deviceFingerprint;
      if (!deviceFingerprint)
        throw new BadRequestException(
          'Device fingerprint required for biometric authorization',
        );
      const verified = await this.securityService.verifyDevice(
        userId,
        deviceFingerprint,
      );
      if (!verified || (verified as any).trusted !== true) {
        throw new BadRequestException('Biometric device verification failed');
      }
    } else {
      if (!dto.pin)
        throw new BadRequestException('Transaction PIN is required');
      await this.authService.verifyPin(userId, dto.pin);
    }

    const amount = Number(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Invalid withdrawal amount');
    }

    const cryptoAddress =
      dto.cryptoAddress ??
      dto.walletAddress ??
      dto.walletaddress ??
      dto.wallet_address;
    const method = dto.method;

    const originalMethodMinima = {
      BANK_TRANSFER: 4999,
      MOBILE_MONEY: 1499,
    } as const;
    const effectiveMinimum =
      originalMethodMinima[method as keyof typeof originalMethodMinima];

    if (method === 'BANK_TRANSFER') {
      if (amount < effectiveMinimum) {
        throw new BadRequestException(
          `Minimum withdrawal amount for bank transfer is ${effectiveMinimum.toLocaleString()} FARM`,
        );
      }
      if (amount > 999999) {
        throw new BadRequestException(
          'Maximum withdrawal amount for bank transfer is 999,999 FARM',
        );
      }
    } else if (method === 'MOBILE_MONEY') {
      if (amount < effectiveMinimum) {
        throw new BadRequestException(
          `Minimum withdrawal amount for mobile money is ${effectiveMinimum.toLocaleString()} FARM`,
        );
      }
      if (amount > 249999) {
        throw new BadRequestException(
          'Maximum withdrawal amount for mobile money is 249,999 FARM',
        );
      }
    }

    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: userId, is_active: true },
    });
    if (!wallet) {
      throw new BadRequestException('Active wallet not found');
    }

    const availableBalance =
      Number(wallet.balance ?? 0) - Number(wallet.locked_balance ?? 0);
    if (availableBalance < amount) {
      throw new BadRequestException('Insufficient balance for this withdrawal');
    }

    if (dto.method === 'MOBILE_MONEY') {
      if (!dto.phoneNumber) {
        throw new BadRequestException(
          'Phone number is required for mobile money withdrawals',
        );
      }
    } else if (dto.method === 'BANK_TRANSFER') {
      if (!dto.accountNumber || !dto.bankName) {
        throw new BadRequestException(
          'Account number and bank name are required for bank transfer withdrawals',
        );
      }
    } else {
      throw new BadRequestException(
        `Unsupported withdrawal method: ${dto.method}`,
      );
    }

    // Platform withdrawal fee from the fee schedule (default 1.5%, all methods)
    const fee = await feeFor(this.fees, 'withdrawal', amount, 8);
    const settlement = Number((amount - fee).toFixed(8));
    const reference = uuidv4();
    const normalizedNetworkValue = dto.network ?? '';
    const normalizedCryptoAsset = dto.cryptoAsset ?? '';

    let paystackConversionSnapshot: any = null;
    {
      const rate = await this.currencyConversionService.getCurrentRate();
      const farmKesRate = Number(rate.farm_kes_rate ?? 0);
      if (!Number.isFinite(farmKesRate) || farmKesRate <= 0) {
        throw new BadRequestException(
          'A valid FARM to KES exchange rate is unavailable',
        );
      }
      const settlementKes =
        Math.round((settlement * farmKesRate + Number.EPSILON) * 100) / 100;
      paystackConversionSnapshot = {
        farmAmount: amount,
        feeFarm: fee,
        settlementFarm: settlement,
        farmKesRate,
        amountKes:
          Math.round((amount * farmKesRate + Number.EPSILON) * 100) / 100,
        feeKes: Math.round((fee * farmKesRate + Number.EPSILON) * 100) / 100,
        settlementKes,
        conversionTimestamp: new Date().toISOString(),
      };
    }

    const withdrawal = await this.prisma.$transaction(async (tx) => {
      await this.lockFundsInTx(tx, wallet.id, userId, amount);

      const created = await tx.withdrawal.create({
        data: {
          userId,
          amount,
          fee,
          settlement,
          total: amount,
          currency: 'FARM',
          method: dto.method,
          accountName: dto.accountName,
          accountNumber: dto.accountNumber,
          bankName: dto.bankName,
          phoneNumber: dto.phoneNumber,
          cryptoAddress,
          cryptoAsset: normalizedCryptoAsset,
          network: normalizedNetworkValue,
          reference,
          status: 'PENDING',
        },
      });

      await tx.transactions.create({
        data: {
          transaction_reference: reference,
          sender_wallet_id: wallet.id,
          transaction_type: 'withdrawal',
          status: 'pending',
          amount,
          fee,
          net_amount: settlement,
          currency: 'FARM',
          description: 'Withdrawal',
          metadata: {
            method: dto.method,
            provider: 'paystack',
            user_id: userId,
            reference,
            cryptoAsset: normalizedCryptoAsset,
            network: normalizedNetworkValue,
            paystack_conversion_snapshot: paystackConversionSnapshot,
          },
        },
      });

      return created;
    });

    setImmediate(() => {
      void this.processWithdrawal(reference).catch((error) =>
        this.logger.error(error?.message ?? error),
      );
    });

    await this.cache.cacheInvalidatePattern(`wallet:${userId}:balance`);
    await this.cache.cacheInvalidatePattern(`dashboard:${userId}`);
    await this.cache.cacheInvalidatePattern(`transactions:${userId}:*`);
    this.websocket.emitBalanceUpdate(userId, availableBalance - amount);

    return { success: true, reference, withdrawal };
  }

  async getNowpaymentsCryptoCurrencies() {
    const currencies = await this.nowpayments.getAvailableCurrencies();
    return { data: currencies };
  }

  async getNowpaymentsCryptoMinimum() {
    const rate = await this.currencyConversionService.getCurrentRate();
    const farmUsdRate = Number(rate.farm_usd_rate ?? 0);
    if (!Number.isFinite(farmUsdRate) || farmUsdRate <= 0) {
      throw new BadRequestException(
        'The FARM/USD exchange rate is unavailable',
      );
    }
    const minimumUsd = MIN_NOWPAYMENTS_CRYPTO_WITHDRAWAL_USD;
    const minimumFarm = Math.ceil((minimumUsd / farmUsdRate) * 1e8) / 1e8;
    return {
      data: {
        minimumUsd,
        farmUsdRate,
        minimumFarm,
      },
    };
  }

  async createNowpaymentsCryptoWithdrawal(
    userId: string,
    dto: CreateWithdrawDto,
    opts: { preAuthorized?: string } = {},
  ) {
    if (opts.preAuthorized) {
      this.logger.log(
        `Crypto withdrawal pre-authorised by ${opts.preAuthorized}`,
      );
    } else if (dto.biometric_auth) {
      const fingerprint = dto.device_fingerprint;
      if (!fingerprint) {
        throw new BadRequestException(
          'Device fingerprint required for biometric authorization',
        );
      }
      const verified = await this.securityService.verifyDevice(
        userId,
        fingerprint,
      );
      if (!verified || (verified as any).trusted !== true) {
        throw new BadRequestException('Biometric device verification failed');
      }
    } else {
      if (!dto.pin) {
        throw new BadRequestException('Transaction PIN is required');
      }
      await this.authService.verifyPin(userId, dto.pin);
    }

    const amount = Number(dto.amount);
    const address = (
      dto.cryptoAddress ??
      dto.walletAddress ??
      dto.walletaddress ??
      dto.wallet_address ??
      ''
    ).trim();
    const currency = (dto.cryptoAsset ?? dto.token ?? '').trim().toLowerCase();
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Enter a valid crypto withdrawal amount');
    }
    if (
      dto.method !== 'CRYPTO' ||
      !address ||
      !/^[a-z0-9]{2,20}$/.test(currency)
    ) {
      throw new BadRequestException(
        'A valid crypto currency and destination address are required',
      );
    }
    const supportedCurrencies = await this.nowpayments.getAvailableCurrencies();
    if (!supportedCurrencies.includes(currency)) {
      throw new BadRequestException(
        'The selected cryptocurrency is not currently available',
      );
    }

    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: userId, is_active: true },
    });
    if (!wallet) {
      throw new BadRequestException('Active wallet not found');
    }
    const availableBalance =
      Number(wallet.balance ?? 0) - Number(wallet.locked_balance ?? 0);
    if (availableBalance < amount) {
      throw new BadRequestException('Insufficient balance for this withdrawal');
    }

    const fee = await feeFor(this.fees, 'withdrawal', amount, 8);
    const settlement = Number((amount - fee).toFixed(8));
    const rate = await this.currencyConversionService.getCurrentRate();
    const farmUsdRate = Number(rate.farm_usd_rate ?? 0);
    const grossAmountUsd = Number((amount * farmUsdRate).toFixed(8));
    if (
      !Number.isFinite(grossAmountUsd) ||
      grossAmountUsd < MIN_NOWPAYMENTS_CRYPTO_WITHDRAWAL_USD
    ) {
      throw new BadRequestException(
        `Minimum crypto withdrawal is USD ${MIN_NOWPAYMENTS_CRYPTO_WITHDRAWAL_USD.toFixed(2)} before the 1.5% withdrawal fee`,
      );
    }
    const settlementUsd = Number((settlement * farmUsdRate).toFixed(2));
    if (!Number.isFinite(settlementUsd) || settlementUsd <= 0) {
      throw new BadRequestException(
        'The crypto withdrawal amount is too small after the withdrawal fee',
      );
    }

    const payoutAmount = await this.nowpayments.estimateAmount(
      settlementUsd,
      'usd',
      currency,
    );
    const minimumPayout = await this.nowpayments.getPayoutMinimum(currency);
    if (payoutAmount < minimumPayout) {
      throw new BadRequestException(
        `NOWPayments minimum payout is ${minimumPayout} ${currency.toUpperCase()}`,
      );
    }
    const networkFee = await this.nowpayments.estimatePayoutFee(
      currency,
      payoutAmount,
    );

    const addressValid = await this.nowpayments.validatePayoutAddress(
      address,
      currency,
      dto.extra_id,
    );
    if (!addressValid) {
      throw new BadRequestException(
        `The destination address is not a valid ${currency.toUpperCase()} address`,
      );
    }

    const reference = uuidv4();
    const withdrawal = await this.prisma.$transaction(async (tx) => {
      await this.lockFundsInTx(tx, wallet.id, userId, amount);
      const created = await tx.withdrawal.create({
        data: {
          userId,
          amount,
          fee,
          settlement,
          total: amount,
          currency: 'FARM',
          method: 'CRYPTO',
          cryptoAddress: address,
          cryptoAsset: currency.toUpperCase(),
          network: dto.network?.trim() || currency.toUpperCase(),
          reference,
          status: 'PENDING',
        },
      });
      await tx.transactions.create({
        data: {
          transaction_reference: reference,
          sender_wallet_id: wallet.id,
          transaction_type: 'withdrawal',
          status: 'pending',
          amount,
          fee,
          net_amount: settlement,
          currency: 'FARM',
          description: 'Crypto withdrawal via NOWPayments',
          metadata: {
            provider: 'nowpayments',
            method: 'CRYPTO',
            user_id: userId,
            reference,
            nowpayments_currency: currency,
            nowpayments_address: address,
            nowpayments_extra_id: dto.extra_id ?? null,
            nowpayments_payout_amount: payoutAmount,
            nowpayments_network_fee_estimate: networkFee,
            nowpayments_payout_status: 'queued',
            payout_approval_status: 'pending',
            amount_farm: amount,
            fee_farm: fee,
            settlement_farm: settlement,
            amount_usd: settlementUsd,
            farm_usd_rate: farmUsdRate,
            conversion_timestamp: new Date().toISOString(),
          },
        },
      });
      return created;
    });

    await Promise.all([
      this.cache.cacheInvalidatePattern(`wallet:${userId}:balance`),
      this.cache.cacheInvalidatePattern(`dashboard:${userId}`),
      this.cache.cacheInvalidatePattern(`transactions:${userId}:*`),
    ]);
    this.websocket.emitBalanceUpdate(userId, availableBalance - amount);
    setImmediate(() => {
      void this.submitNowpaymentsPayout(reference, 'system:auto').catch(
        (error) =>
          this.logger.warn(
            `Automatic NOWPayments payout for ${reference} did not complete: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
      );
    });
    return {
      success: true,
      reference,
      status: 'PROCESSING',
      withdrawal,
      estimated_crypto_amount: payoutAmount,
      estimated_network_fee: networkFee,
      currency: currency.toUpperCase(),
      message: 'Withdrawal submitted for payout',
    };
  }

  async getPendingNowpaymentsCryptoWithdrawals() {
    const transactions = await this.prisma.transactions.findMany({
      where: {
        transaction_type: 'withdrawal',
        status: { in: ['pending', 'processing'] },
      },
      select: {
        transaction_reference: true,
        amount: true,
        metadata: true,
        status: true,
        created_at: true,
      },
      orderBy: { created_at: 'asc' },
      take: 100,
    });
    const pending = transactions.filter((transaction) => {
      const metadata =
        (transaction.metadata as Record<string, unknown> | null) ?? {};
      const rawPayoutStatus = metadata.nowpayments_payout_status;
      const payoutStatus = (
        typeof rawPayoutStatus === 'string' ? rawPayoutStatus : ''
      ).toLowerCase();
      return (
        metadata.provider === 'nowpayments' &&
        ['pending', 'processing'].includes(
          String(transaction.status).toLowerCase(),
        ) &&
        ['pending', 'approved'].includes(
          String(metadata.payout_approval_status),
        ) &&
        (!metadata.nowpayments_payout_id ||
          ['creating', 'unknown'].includes(payoutStatus) ||
          metadata.payout_approval_status === 'pending')
      );
    });
    return Promise.all(
      pending.map(async (transaction) => ({
        ...transaction,
        withdrawal: await this.prisma.withdrawal.findUnique({
          where: { reference: transaction.transaction_reference },
        }),
      })),
    );
  }

  /** Admin-triggered retry/reconcile. Never re-submits a payout whose outcome is unknown. */
  async approveNowpaymentsCryptoWithdrawal(reference: string, adminId: string) {
    return this.submitNowpaymentsPayout(reference, adminId);
  }

  async submitNowpaymentsPayout(reference: string, adminId: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { reference },
    });
    const transaction = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
    });
    const metadata =
      (transaction?.metadata as Record<string, any> | null) ?? {};
    if (
      !withdrawal ||
      !transaction ||
      metadata.provider !== 'nowpayments' ||
      withdrawal.method !== 'CRYPTO'
    ) {
      throw new BadRequestException('NOWPayments withdrawal was not found');
    }
    if (metadata.nowpayments_payout_id) {
      return {
        success: true,
        payout_id: metadata.nowpayments_payout_id,
        status: metadata.nowpayments_payout_status,
        requires_provider_verification:
          metadata.nowpayments_payout_status === 'creating',
      };
    }
    const retryUnknownPayout =
      withdrawal.status === 'PROCESSING' &&
      metadata.payout_approval_status === 'approved' &&
      ['creating', 'unknown'].includes(
        String(metadata.nowpayments_payout_status ?? '').toLowerCase(),
      );
    if (
      !retryUnknownPayout &&
      (withdrawal.status !== 'PENDING' ||
        metadata.payout_approval_status !== 'pending')
    ) {
      throw new BadRequestException(
        'This crypto withdrawal is no longer awaiting approval',
      );
    }

    if (retryUnknownPayout) {
      // Outcome of an earlier submission is unknown: look it up by our
      // unique_external_id instead of creating a second payout.
      const found = await this.nowpayments.findPayoutByExternalId(reference);
      if (!found) {
        await this.prisma.transactions.update({
          where: { id: transaction.id },
          data: {
            metadata: {
              ...metadata,
              nowpayments_payout_lookup_at: new Date().toISOString(),
            },
          },
        });
        throw new BadRequestException(
          'No NOWPayments payout exists for this reference yet. It will not be re-submitted automatically; confirm in the NOWPayments dashboard, then reject the withdrawal to refund it.',
        );
      }
      return this.recordPayoutCreated(
        transaction.id,
        reference,
        found,
        adminId,
      );
    }

    const claimed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.withdrawal.updateMany({
        where: { reference, status: 'PENDING' },
        data: { status: 'PROCESSING' },
      });
      if (updated.count !== 1) return false;
      await tx.transactions.update({
        where: { id: transaction.id },
        data: {
          metadata: {
            ...metadata,
            payout_approval_status: 'approved',
            payout_approved_by: adminId,
            payout_approved_at: new Date().toISOString(),
            nowpayments_payout_status: 'creating',
          },
        },
      });
      return true;
    });
    if (!claimed) {
      throw new BadRequestException(
        'This crypto withdrawal was already approved',
      );
    }

    let payout: Record<string, any>;
    try {
      payout = await this.nowpayments.createPayout({
        address: String(metadata.nowpayments_address),
        currency: String(metadata.nowpayments_currency),
        amount: Number(metadata.nowpayments_payout_amount),
        reference,
      });
    } catch (error) {
      const current = await this.prisma.transactions.findUnique({
        where: { id: transaction.id },
        select: { metadata: true },
      });
      const currentMetadata =
        (current?.metadata as Record<string, any> | null) ?? metadata;
      await this.prisma.transactions.update({
        where: { id: transaction.id },
        data: {
          metadata: {
            ...currentMetadata,
            payout_approval_status: 'approved',
            nowpayments_payout_status: 'unknown',
            nowpayments_payout_creation_error:
              error instanceof Error ? error.message : 'Provider error',
            nowpayments_payout_last_attempt_at: new Date().toISOString(),
          },
        },
      });
      this.logger.error(
        `NOWPayments payout creation outcome is unknown for ${reference}; funds remain reserved`,
      );
      throw new BadGatewayException(
        'NOWPayments payout status is not yet known. Funds remain reserved; it will be looked up (never re-submitted) by the reconciler.',
      );
    }
    return this.recordPayoutCreated(transaction.id, reference, payout, adminId);
  }

  private async recordPayoutCreated(
    transactionId: string,
    reference: string,
    payout: Record<string, any>,
    adminId: string,
  ) {
    const payoutId = String(
      payout.id ??
        payout.batch_withdrawal_id ??
        payout.withdrawals?.[0]?.id ??
        '',
    );
    if (!payoutId) {
      throw new BadRequestException(
        'NOWPayments payout was submitted but did not return a payout ID; funds remain reserved for reconciliation',
      );
    }
    const payoutStatus = String(
      payout.status ?? payout.withdrawals?.[0]?.status ?? 'creating',
    ).toLowerCase();
    const current = await this.prisma.transactions.findUnique({
      where: { id: transactionId },
      select: { metadata: true },
    });
    const metadata = (current?.metadata as Record<string, any> | null) ?? {};
    await this.prisma.transactions.update({
      where: { id: transactionId },
      data: {
        metadata: {
          ...metadata,
          payout_approval_status: 'approved',
          payout_approved_by: metadata.payout_approved_by ?? adminId,
          nowpayments_payout_id: payoutId,
          nowpayments_payout_status: payoutStatus,
          nowpayments_payout_response: payout,
        },
      },
    });
    let status = payoutStatus;
    if (status === 'creating') {
      const code = this.nowpayments.generatePayoutVerificationCode();
      if (code) {
        try {
          const verified = await this.verifyNowpaymentsCryptoWithdrawal(
            reference,
            code,
            'system:auto',
          );
          status = verified.status;
        } catch (error) {
          this.logger.warn(
            `Automatic NOWPayments payout verification failed for ${reference}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    return {
      success: true,
      payout_id: payoutId,
      status,
      requires_provider_verification: status === 'creating',
    };
  }

  async verifyNowpaymentsCryptoWithdrawal(
    reference: string,
    verificationCode: string,
    adminId: string,
  ) {
    const transaction = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
    });
    const metadata =
      (transaction?.metadata as Record<string, any> | null) ?? {};
    const payoutId = String(metadata.nowpayments_payout_id ?? '');
    if (
      !transaction ||
      metadata.provider !== 'nowpayments' ||
      metadata.payout_approval_status !== 'approved' ||
      !payoutId
    ) {
      throw new BadRequestException(
        'An approved NOWPayments payout is required before verification',
      );
    }
    const response = await this.nowpayments.verifyPayout(
      payoutId,
      verificationCode,
    );
    const status = String(
      response.status ?? response.withdrawals?.[0]?.status ?? 'creating',
    ).toLowerCase();
    await this.prisma.transactions.update({
      where: { id: transaction.id },
      data: {
        metadata: {
          ...metadata,
          nowpayments_payout_status: status,
          nowpayments_payout_verified_by: adminId,
          nowpayments_payout_verified_at: new Date().toISOString(),
          nowpayments_payout_verification_response: response,
        },
      },
    });
    return {
      success: true,
      payout_id: payoutId,
      status,
      requires_provider_verification: status === 'creating',
    };
  }

  async reconcileNowpaymentsPayoutWebhook(payload: Record<string, any>) {
    const payoutId = String(
      payload.id ??
        payload.payout_id ??
        payload.batch_withdrawal_id ??
        payload.withdrawal_id ??
        '',
    );
    if (!payoutId) {
      this.logger.warn(
        'NOWPayments payout webhook did not include a payout ID',
      );
      return false;
    }
    const transaction = await this.prisma.transactions.findFirst({
      where: {
        transaction_type: 'withdrawal',
        metadata: {
          path: ['nowpayments_payout_id'],
          equals: payoutId,
        },
      },
    });
    if (!transaction) {
      this.logger.warn(
        `NOWPayments payout webhook did not match payout ${payoutId}`,
      );
      return false;
    }
    const verified = await this.nowpayments.getPayout(payoutId);
    const status = String(
      verified.status ?? verified.withdrawals?.[0]?.status ?? '',
    ).toLowerCase();
    const metadata =
      (transaction.metadata as Record<string, unknown> | null) ?? {};
    await this.prisma.transactions.update({
      where: { id: transaction.id },
      data: {
        metadata: {
          ...metadata,
          nowpayments_payout_status: status || 'unknown',
          nowpayments_payout_last_checked_at: new Date().toISOString(),
          nowpayments_payout_response: verified,
        },
      },
    });
    if (['finished', 'success', 'completed'].includes(status)) {
      return this.markAsSuccess(transaction.transaction_reference);
    }
    if (['failed', 'rejected', 'cancelled', 'canceled'].includes(status)) {
      return this.rejectWithdrawal(
        transaction.transaction_reference,
        String(verified.failure_reason ?? 'NOWPayments payout failed'),
      );
    }
    return false;
  }

  async getUserWithdrawals(userId: string) {
    return this.prisma.withdrawal.findMany({
      where: { userId, status: { not: 'FAILED' } },
      orderBy: { createdAt: 'desc' },
    });
  }

  getProviderNetworks(token?: string) {
    return this.nowpayments.getAvailableCurrencies().then((currencies) => {
      const normalizedToken = token?.trim().toLowerCase();
      const options = currencies
        .filter(
          (currency) =>
            !normalizedToken || currency.startsWith(normalizedToken),
        )
        .map((currency) => ({
          token: currency.toUpperCase(),
          network: currency,
          networkName: currency.toUpperCase(),
        }));
      return { data: options };
    });
  }

  async getWithdrawal(id: string, userId?: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { id },
    });
    if (!withdrawal) {
      return null;
    }

    assertResourceAccess(withdrawal.userId, userId, 'withdrawal');
    return withdrawal;
  }

  async getWithdrawalStatus(reference: string, userId: string) {
    const withdrawal = await this.prisma.withdrawal.findFirst({
      where: { reference, userId },
    });
    if (!withdrawal) {
      return null;
    }

    const transaction = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
    });
    const metadata = (transaction?.metadata as any) ?? {};
    const statusResult: any = {
      reference,
      withdrawal_status: withdrawal.status,
      provider:
        metadata.provider ??
        (withdrawal.method === 'CRYPTO' ? 'legacy' : 'paystack'),
      method: withdrawal.method,
      amount: withdrawal.amount,
      currency: withdrawal.currency,
      rejection_reason: withdrawal.rejectionReason,
    };

    if (withdrawal.method === 'CRYPTO' && metadata.provider === 'nowpayments') {
      statusResult.nowpayments_payout_id = metadata.nowpayments_payout_id;
      statusResult.nowpayments_payout_status =
        metadata.nowpayments_payout_status;
      statusResult.payout_approval_status = metadata.payout_approval_status;
      statusResult.estimated_crypto_amount = metadata.nowpayments_payout_amount;
      if (
        metadata.nowpayments_payout_id &&
        withdrawal.status.toUpperCase() === 'PROCESSING'
      ) {
        try {
          const verified = await this.nowpayments.getPayout(
            String(metadata.nowpayments_payout_id),
          );
          const providerStatus = String(
            verified.status ?? verified.withdrawals?.[0]?.status ?? '',
          ).toLowerCase();
          statusResult.nowpayments_payout_status =
            providerStatus || metadata.nowpayments_payout_status;
          const latestMetadata =
            (transaction?.metadata as Record<string, unknown> | null) ?? {};
          if (transaction) {
            await this.prisma.transactions.update({
              where: { id: transaction.id },
              data: {
                metadata: {
                  ...latestMetadata,
                  nowpayments_payout_status:
                    providerStatus || metadata.nowpayments_payout_status,
                  nowpayments_payout_last_checked_at: new Date().toISOString(),
                  nowpayments_payout_response: verified,
                },
              },
            });
          }
          if (['finished', 'success', 'completed'].includes(providerStatus)) {
            await this.markAsSuccess(reference);
          } else if (
            ['failed', 'rejected', 'cancelled', 'canceled'].includes(
              providerStatus,
            )
          ) {
            await this.rejectWithdrawal(
              reference,
              String(verified.failure_reason ?? 'NOWPayments payout failed'),
            );
          }
          const latestWithdrawal = await this.prisma.withdrawal.findFirst({
            where: { reference, userId },
          });
          if (latestWithdrawal) {
            statusResult.withdrawal_status = latestWithdrawal.status;
          }
        } catch (error) {
          statusResult.nowpayments_status_error =
            error instanceof Error
              ? error.message
              : 'Unable to verify NOWPayments payout status';
          this.logger.warn(
            `NOWPayments withdrawal status check failed for ${reference}: ${statusResult.nowpayments_status_error}`,
          );
        }
      }
    } else if (
      ['PENDING', 'PROCESSING'].includes(withdrawal.status.toUpperCase())
    ) {
      statusResult.paystack_transfer_code = metadata.paystack_transfer_code;
      statusResult.paystack_transfer_status = metadata.paystack_transfer_status;
      statusResult.paystack_failure_reason = metadata.paystack_failure_reason;
      try {
        const transferStatus =
          await this.paystack.getTransferByReference(reference);
        statusResult.paystack_transfer_details = transferStatus;
        statusResult.paystack_transfer_code =
          transferStatus.transfer_code ?? statusResult.paystack_transfer_code;
        statusResult.paystack_transfer_status =
          transferStatus.status ?? statusResult.paystack_transfer_status;
        const normalizedStatus = String(
          transferStatus.status ?? '',
        ).toLowerCase();
        if (normalizedStatus === 'success') {
          await this.markAsSuccess(reference);
        } else if (['failed', 'reversed'].includes(normalizedStatus)) {
          await this.rejectWithdrawal(
            reference,
            transferStatus.reason ||
              transferStatus.failure_message ||
              'Paystack transfer failed',
          );
        } else {
          const latestTransaction = await this.prisma.transactions.findUnique({
            where: { transaction_reference: reference },
          });
          if (latestTransaction) {
            const latestMetadata = (latestTransaction.metadata as any) ?? {};
            await this.prisma.transactions.update({
              where: { id: latestTransaction.id },
              data: {
                metadata: {
                  ...latestMetadata,
                  provider: 'paystack',
                  paystack_transfer_code:
                    transferStatus.transfer_code ??
                    latestMetadata.paystack_transfer_code,
                  paystack_transfer_status: transferStatus.status ?? 'pending',
                  paystack_transfer_requires_otp: normalizedStatus === 'otp',
                  paystack_transfer_last_checked_at: new Date().toISOString(),
                },
              },
            });
          }
          if (normalizedStatus === 'otp') {
            this.logger.warn(
              `Paystack transfer ${reference} requires OTP confirmation; disable transfer OTP in Paystack to enable automatic payouts.`,
            );
          }
        }

        const latestWithdrawal = await this.prisma.withdrawal.findFirst({
          where: { reference, userId },
        });
        if (latestWithdrawal) {
          statusResult.withdrawal_status = latestWithdrawal.status;
        }
      } catch (e: any) {
        statusResult.paystack_transfer_status_error =
          e.message || 'Unable to query Paystack transfer status';
      }
    }

    return statusResult;
  }

  @Cron('* * * * *')
  async reconcilePendingPaystackWithdrawals() {
    if (this.reconcilingPaystackWithdrawals) return;
    this.reconcilingPaystackWithdrawals = true;

    try {
      const cutoff = new Date(Date.now() - 60_000);
      const pending = await this.prisma.withdrawal.findMany({
        where: {
          status: 'PROCESSING',
          method: { in: ['MOBILE_MONEY', 'BANK_TRANSFER'] },
          updatedAt: { lt: cutoff },
        },
        select: { reference: true, userId: true },
        orderBy: { updatedAt: 'asc' },
        take: 50,
      });

      for (const withdrawal of pending) {
        try {
          const status = await this.getWithdrawalStatus(
            withdrawal.reference,
            withdrawal.userId,
          );
          if (status?.withdrawal_status === 'PROCESSING') {
            await this.prisma.withdrawal.updateMany({
              where: {
                reference: withdrawal.reference,
                status: 'PROCESSING',
              },
              data: { updatedAt: new Date() },
            });
          }
        } catch (error) {
          this.logger.error(
            `Paystack withdrawal reconciliation failed for ${withdrawal.reference}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Could not load pending Paystack withdrawals for reconciliation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.reconcilingPaystackWithdrawals = false;
    }
  }

  /** Re-checks NOWPayments payouts so a missed IPN can never strand funds. */
  @Cron('*/5 * * * *')
  async reconcileNowpaymentsPayouts() {
    if (this.reconcilingNowpaymentsPayouts) return;
    this.reconcilingNowpaymentsPayouts = true;
    try {
      const cutoff = new Date(Date.now() - 2 * 60_000);
      const candidates = await this.prisma.transactions.findMany({
        where: {
          transaction_type: 'withdrawal',
          status: { in: ['pending', 'processing'] },
          created_at: { lt: cutoff },
          metadata: { path: ['provider'], equals: 'nowpayments' },
        },
        select: { transaction_reference: true, metadata: true },
        orderBy: { created_at: 'asc' },
        take: 50,
      });
      for (const candidate of candidates) {
        const reference = candidate.transaction_reference;
        const metadata =
          (candidate.metadata as Record<string, any> | null) ?? {};
        try {
          if (metadata.nowpayments_payout_id) {
            await this.reconcileNowpaymentsPayoutWebhook({
              id: metadata.nowpayments_payout_id,
            });
          } else if (metadata.payout_approval_status === 'pending') {
            // Auto-submit never ran (e.g. restart): submit now. Claim is guarded.
            await this.submitNowpaymentsPayout(reference, 'system:reconciler');
          } else {
            const found =
              await this.nowpayments.findPayoutByExternalId(reference);
            if (found) {
              const tx = await this.prisma.transactions.findUnique({
                where: { transaction_reference: reference },
                select: { id: true },
              });
              if (tx) {
                await this.recordPayoutCreated(
                  tx.id,
                  reference,
                  found,
                  'system:reconciler',
                );
              }
            }
          }
        } catch (error) {
          this.logger.warn(
            `NOWPayments payout reconciliation failed for ${reference}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `Could not load NOWPayments payouts for reconciliation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.reconcilingNowpaymentsPayouts = false;
    }
  }

  /** Legacy IvoryPay withdrawals still holding locked funds (read-only). */
  async listStuckLegacyWithdrawals() {
    const rows = await this.prisma.withdrawal.findMany({
      where: { method: 'CRYPTO', status: { in: ['PENDING', 'PROCESSING'] } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    const result: any[] = [];
    for (const row of rows) {
      const tx = await this.prisma.transactions.findUnique({
        where: { transaction_reference: row.reference },
        select: { metadata: true },
      });
      const provider = (tx?.metadata as any)?.provider;
      if (provider !== 'nowpayments')
        result.push({ ...row, provider: provider ?? 'ivorypay' });
    }
    return result;
  }

  /** Refunds (unlocks) and closes one stuck legacy IvoryPay withdrawal. SUPER_ADMIN only. */
  async refundLegacyWithdrawal(
    idOrReference: string,
    adminId: string,
    reason?: string,
  ) {
    const withdrawal = await this.prisma.withdrawal.findFirst({
      where: { OR: [{ id: idOrReference }, { reference: idOrReference }] },
    });
    if (!withdrawal || withdrawal.method !== 'CRYPTO') {
      throw new BadRequestException('Legacy crypto withdrawal not found');
    }
    const tx = await this.prisma.transactions.findUnique({
      where: { transaction_reference: withdrawal.reference },
      select: { metadata: true },
    });
    if ((tx?.metadata as any)?.provider === 'nowpayments') {
      throw new BadRequestException(
        'Only legacy (IvoryPay) withdrawals can be closed here',
      );
    }
    if (!['PENDING', 'PROCESSING'].includes(withdrawal.status)) {
      throw new BadRequestException('This withdrawal is already closed');
    }
    this.logger.warn(
      `Legacy withdrawal ${withdrawal.reference} refunded and closed by ${adminId}`,
    );
    return this.rejectWithdrawal(
      withdrawal.reference,
      reason ?? 'IvoryPay retired: legacy withdrawal refunded and closed',
    );
  }

  private async processWithdrawal(reference: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { reference },
      include: {
        user: {
          select: {
            first_name: true,
            last_name: true,
          },
        },
      },
    });
    if (!withdrawal || (withdrawal.status && withdrawal.status !== 'PENDING'))
      return;

    const claim = await this.prisma.withdrawal.updateMany({
      where: { reference, status: 'PENDING' },
      data: { status: 'PROCESSING' },
    });
    if (claim.count !== 1) return;

    try {
      let recipient: any;

      if (withdrawal.method === 'MOBILE_MONEY') {
        const phoneNumber = this.formatMpesaNumber(withdrawal.phoneNumber);
        recipient = await this.paystack.createTransferRecipient({
          type: 'mobile_money',
          name:
            withdrawal.accountName ||
            `${withdrawal.user?.first_name ?? ''} ${withdrawal.user?.last_name ?? ''}`.trim() ||
            'FARM User',
          account_number: phoneNumber,
          bank_code: 'MPESA',
          currency: 'KES',
        });
      } else if (withdrawal.method === 'BANK_TRANSFER') {
        const bankCode = await this.paystack.getBankCodeByName(
          withdrawal.bankName || '',
        );
        this.logger.log(
          `Resolved bank name='${withdrawal.bankName}' -> bank_code='${bankCode}'`,
        );
        recipient = await this.paystack.createTransferRecipient({
          type: 'kepss',
          name:
            withdrawal.accountName ||
            `${withdrawal.user?.first_name ?? ''} ${withdrawal.user?.last_name ?? ''}`.trim() ||
            'FARM User',
          account_number: withdrawal.accountNumber!,
          bank_code: bankCode,
          currency: 'KES',
        });
      } else {
        throw new BadRequestException(
          'Unsupported withdrawal method for transfer processing',
        );
      }

      if (recipient) {
        const transaction = await this.prisma.transactions.findUnique({
          where: { transaction_reference: reference },
        });
        const metadata = (transaction?.metadata as any) ?? {};
        const snapshot = metadata.paystack_conversion_snapshot;
        const farmKesRate = Number(snapshot?.farmKesRate ?? 0);
        const settlementKes = Number(
          snapshot?.settlementKes ??
            (farmKesRate > 0
              ? Math.round(
                  (Number(withdrawal.settlement) * farmKesRate +
                    Number.EPSILON) *
                    100,
                ) / 100
              : NaN),
        );
        const payoutAmount =
          Number.isFinite(settlementKes) && settlementKes > 0
            ? settlementKes
            : await this.currencyConversionService.farmToKes(
                Number(withdrawal.settlement),
              );
        if (!Number.isFinite(payoutAmount) || payoutAmount <= 0) {
          throw new BadRequestException('Invalid KES payout amount');
        }

        const transferResponse = await this.paystack.initiateTransfer({
          source: 'balance',
          amount: payoutAmount,
          recipient: recipient.recipient_code,
          reference,
          currency: 'KES',
          reason: `FARM withdrawal ${reference}`,
        });

        const transferData = transferResponse?.data ?? {};
        if (transaction) {
          const updatedMetadata = {
            ...metadata,
            paystack_transfer_code:
              transferData.transfer_code ||
              transferData.id ||
              metadata.paystack_transfer_code,
            paystack_transfer_status:
              transferData.status ||
              metadata.paystack_transfer_status ||
              'pending',
            paystack_transfer_requires_otp:
              String(transferData.status ?? '').toLowerCase() === 'otp',
            paystack_transfer_initiated_at: new Date().toISOString(),
          };
          await this.prisma.transactions.update({
            where: { id: transaction.id },
            data: { metadata: updatedMetadata },
          });
          if (String(transferData.status ?? '').toLowerCase() === 'otp') {
            this.logger.warn(
              `Paystack transfer ${reference} requires OTP confirmation; disable transfer OTP in Paystack to enable automatic payouts.`,
            );
          }
        }
      }
      // Do NOT mark success here – wait for webhook or provider callback
    } catch (e: any) {
      if (
        e instanceof PaystackTransferInitiationError &&
        e.outcome === 'unknown'
      ) {
        const transaction = await this.prisma.transactions.findUnique({
          where: { transaction_reference: reference },
        });
        if (transaction) {
          const metadata = (transaction.metadata as any) ?? {};
          await this.prisma.transactions.update({
            where: { id: transaction.id },
            data: {
              metadata: {
                ...metadata,
                paystack_transfer_status: 'unknown',
                paystack_transfer_outcome_unknown_reason: e.message,
              },
            },
          });
        }
        return;
      }
      await this.rejectWithdrawal(
        reference,
        e.message || 'Withdrawal transfer failed',
      );
    }
  }

  // Called from webhook
  async markAsSuccess(reference: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { reference },
    });
    if (!withdrawal) return false;
    if (withdrawal.status === 'COMPLETED') return true;
    if (withdrawal.status === 'FAILED') return false;

    const transaction = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
    });
    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: withdrawal.userId, is_active: true },
    });
    if (!wallet) return false;

    const amount = Number(withdrawal.amount ?? 0);
    const previousBalance = Number(wallet.balance ?? 0);
    const previousLocked = Number(wallet.locked_balance ?? 0);
    const unlockAmount = Math.min(previousLocked, amount);

    const finalized = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.withdrawal.updateMany({
        where: { reference, status: { in: ['PENDING', 'PROCESSING'] } },
        data: { status: 'COMPLETED' },
      });
      if (claim.count !== 1) return false;

      // Guarded debit: never takes balance or locked_balance below zero.
      const debited = await tx.$executeRaw`
        UPDATE wallets
           SET balance = COALESCE(balance, 0) - ${amount}::numeric,
               locked_balance = GREATEST(COALESCE(locked_balance, 0) - ${amount}::numeric, 0)
         WHERE id = ${wallet.id}::uuid
           AND COALESCE(balance, 0) >= ${amount}::numeric`;
      if (debited !== 1) {
        throw new BadRequestException(
          `Wallet balance is insufficient to finalize withdrawal ${reference}`,
        );
      }

      if (transaction) {
        const existingMetadata =
          (transaction.metadata as Record<string, any> | null) ?? {};
        const provider = existingMetadata.provider;
        await tx.transactions.update({
          where: { id: transaction.id },
          data: {
            status: 'completed',
            processed_at: new Date(),
            description: 'Successful withdrawal',
            metadata:
              withdrawal.method === 'CRYPTO'
                ? provider === 'nowpayments'
                  ? {
                      ...existingMetadata,
                      nowpayments_payout_status: 'finished',
                    }
                  : { ...existingMetadata, legacy_status: 'success' }
                : {
                    ...existingMetadata,
                    provider: 'paystack',
                    paystack_transfer_status: 'success',
                  },
          },
        });

        await tx.ledger_entries.create({
          data: {
            transaction_id: transaction.id,
            wallet_id: wallet.id,
            entry_type: 'debit',
            amount,
            balance_before: previousBalance,
            balance_after: previousBalance - amount,
            description: `Withdrawal completed — ref: ${reference}`,
          },
        });
      }

      await this.creditPlatformFeeInTx(
        tx,
        Number(withdrawal.fee ?? 0),
        reference,
        transaction?.id,
      );
      return true;
    });
    if (!finalized) return false;

    await Promise.all([
      this.cache.cacheInvalidatePattern(`wallet:${withdrawal.userId}:balance`),
      this.cache.cacheInvalidatePattern(`dashboard:${withdrawal.userId}`),
      this.cache.cacheInvalidatePattern(`transactions:${withdrawal.userId}:*`),
      this.cache.cacheDelete('admin:dashboard:stats'),
      this.cache.cacheDelete('admin:analytics'),
      this.cache.cacheDelete('admin:superadmin-dashboard'),
    ]);
    this.websocket.emitBalanceUpdate(
      withdrawal.userId,
      previousBalance - amount - (previousLocked - unlockAmount),
    );

    await this.notificationsService.sendNotification(withdrawal.userId, {
      type: 'withdrawal_completed',
      title: 'Withdrawal completed',
      body: `Your withdrawal of ${Number(withdrawal.amount ?? 0)} FARM has been processed successfully.`,
      entityId: withdrawal.id,
      metadata: {
        reference,
        amount: Number(withdrawal.amount ?? 0),
        currency: withdrawal.currency || 'FARM',
      },
    });

    return true;
  }

  async creditPlatformFeeInTx(
    tx: any,
    platformFee: number,
    referenceOrDescription: string,
    transactionId?: string,
  ) {
    if (platformFee <= 0) return;

    const description = transactionId
      ? `Platform withdrawal fee credited — ref: ${referenceOrDescription}`
      : referenceOrDescription;

    const superadminUser = await tx.users.findFirst({
      where: { role: 'super_admin', is_deleted: false },
      include: { wallets: { where: { is_active: true }, take: 1 } },
    });
    const superWallet = superadminUser?.wallets?.[0];
    if (!superWallet) {
      throw new BadRequestException('Superadmin wallet not found');
    }

    const previousBalance = Number(superWallet.balance ?? 0);
    await tx.wallets.update({
      where: { id: superWallet.id },
      data: { balance: { increment: platformFee } },
    });
    await tx.ledger_entries.create({
      data: {
        transaction_id: transactionId ?? null,
        wallet_id: superWallet.id,
        entry_type: 'credit',
        amount: platformFee,
        balance_before: previousBalance,
        balance_after: previousBalance + platformFee,
        description,
      },
    });
  }

  async reconcileCompletedPlatformFees() {
    await this.prisma.$transaction(async (tx) => {
      const superadminUser = await tx.users.findFirst({
        where: { role: 'super_admin', is_deleted: false },
        include: { wallets: { where: { is_active: true }, take: 1 } },
      });
      const superWallet = superadminUser?.wallets?.[0];
      if (!superWallet) return;
      let currentBalance = Number(superWallet.balance ?? 0);

      const completedWithdrawals = await tx.transactions.findMany({
        where: {
          transaction_type: 'withdrawal',
          status: 'completed',
          fee: { gt: 0 },
          metadata: { path: ['provider'], equals: 'paystack' },
        },
        select: {
          id: true,
          transaction_reference: true,
          fee: true,
        },
      });

      for (const transaction of completedWithdrawals) {
        const fee = Number(transaction.fee ?? 0);
        if (!Number.isFinite(fee) || fee <= 0) continue;

        const existingEntry = await tx.ledger_entries.findFirst({
          where: {
            transaction_id: transaction.id,
            wallet_id: superWallet.id,
            entry_type: 'credit',
          },
        });
        if (existingEntry) continue;

        const previousBalance = currentBalance;
        await tx.wallets.update({
          where: { id: superWallet.id },
          data: { balance: { increment: fee } },
        });
        await tx.ledger_entries.create({
          data: {
            transaction_id: transaction.id,
            wallet_id: superWallet.id,
            entry_type: 'credit',
            amount: fee,
            balance_before: previousBalance,
            balance_after: previousBalance + fee,
            description: `Platform withdrawal fee credited — ref: ${transaction.transaction_reference}`,
          },
        });
        currentBalance = previousBalance + fee;
      }
    });
  }

  async rejectWithdrawal(reference: string, reason: string) {
    const withdrawal = await this.prisma.withdrawal.findUnique({
      where: { reference },
    });
    if (!withdrawal) return false;
    if (withdrawal.status === 'FAILED') return true;
    if (withdrawal.status === 'COMPLETED') return false;

    const transaction = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
    });
    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: withdrawal.userId, is_active: true },
    });
    if (!wallet) return false;

    const amount = Number(withdrawal.amount ?? 0);
    const previousLocked = Number(wallet.locked_balance ?? 0);
    const unlockAmount = Math.min(previousLocked, amount);

    const rejected = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.withdrawal.updateMany({
        where: { reference, status: { in: ['PENDING', 'PROCESSING'] } },
        data: { status: 'FAILED', rejectionReason: reason },
      });
      if (claim.count !== 1) return false;

      await tx.$executeRaw`
        UPDATE wallets
           SET locked_balance = GREATEST(COALESCE(locked_balance, 0) - ${amount}::numeric, 0)
         WHERE id = ${wallet.id}::uuid`;

      if (transaction) {
        const metadata = (transaction.metadata as any) ?? {};
        const failureMetadata =
          withdrawal.method === 'CRYPTO' && metadata.provider === 'nowpayments'
            ? {
                ...metadata,
                nowpayments_failure_reason: reason,
                nowpayments_payout_status: 'failed',
              }
            : withdrawal.method === 'CRYPTO'
              ? {
                  ...metadata,
                  legacy_failure_reason: reason,
                  legacy_status: 'failed',
                }
              : {
                  ...metadata,
                  provider: 'paystack',
                  paystack_failure_reason: reason,
                  paystack_transfer_status: 'failed',
                };
        await tx.transactions.update({
          where: { id: transaction.id },
          data: {
            status: 'failed',
            processed_at: new Date(),
            metadata: failureMetadata,
          },
        });
      }
      return true;
    });
    if (!rejected) return false;

    await Promise.all([
      this.cache.cacheInvalidatePattern(`wallet:${withdrawal.userId}:balance`),
      this.cache.cacheInvalidatePattern(`dashboard:${withdrawal.userId}`),
      this.cache.cacheInvalidatePattern(`transactions:${withdrawal.userId}:*`),
      this.cache.cacheDelete('admin:dashboard:stats'),
      this.cache.cacheDelete('admin:analytics'),
      this.cache.cacheDelete('admin:superadmin-dashboard'),
    ]);
    this.websocket.emitBalanceUpdate(
      withdrawal.userId,
      Number(wallet.balance ?? 0) - (previousLocked - unlockAmount),
    );

    await this.notificationsService.sendNotification(withdrawal.userId, {
      type: 'transaction',
      title: 'Withdrawal failed',
      body: reason
        ? `Your withdrawal could not be completed: ${reason}`
        : 'Your withdrawal could not be completed.',
      entityId: withdrawal.id,
      metadata: { reference, reason },
    });

    return true;
  }

  async getPaystackDestinations(type?: string) {
    return this.paystack.getBanks('KES', type);
  }

  async adminApproveWithdrawal(idOrReference: string) {
    const withdrawal = await this.prisma.withdrawal.findFirst({
      where: { OR: [{ id: idOrReference }, { reference: idOrReference }] },
    });
    if (!withdrawal) throw new BadRequestException('Withdrawal not found');
    if (withdrawal.status === 'COMPLETED') return true;
    if (withdrawal.status === 'FAILED') {
      throw new BadRequestException('A rejected withdrawal cannot be approved');
    }
    return this.markAsSuccess(withdrawal.reference);
  }

  async adminRejectWithdrawal(idOrReference: string, reason: string) {
    const withdrawal = await this.prisma.withdrawal.findFirst({
      where: { OR: [{ id: idOrReference }, { reference: idOrReference }] },
    });
    if (!withdrawal) throw new BadRequestException('Withdrawal not found');
    return this.rejectWithdrawal(withdrawal.reference, reason);
  }

  /**
   * Atomically reserves `amount` on the wallet inside `tx`. The availability
   * check and the increment are one UPDATE, so concurrent requests cannot
   * over-reserve. The row lock it takes also serialises the daily-limit check.
   */
  private async lockFundsInTx(
    tx: any,
    walletId: string,
    userId: string,
    amount: number,
  ) {
    const locked = await tx.$executeRaw`
      UPDATE wallets
         SET locked_balance = COALESCE(locked_balance, 0) + ${amount}::numeric
       WHERE id = ${walletId}::uuid
         AND COALESCE(is_frozen, false) = false
         AND COALESCE(balance, 0) - COALESCE(locked_balance, 0) >= ${amount}::numeric`;
    if (locked !== 1) {
      throw new BadRequestException('Insufficient balance for this withdrawal');
    }
    const { maxCount, maxAmount } = withdrawalDailyLimits();
    if (maxCount > 0 || maxAmount > 0) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recent = await tx.withdrawal.aggregate({
        where: { userId, createdAt: { gte: since }, status: { not: 'FAILED' } },
        _count: { _all: true },
        _sum: { amount: true },
      });
      const count = Number(recent?._count?._all ?? 0);
      const total = Number(recent?._sum?.amount ?? 0);
      if (maxCount > 0 && count + 1 > maxCount) {
        throw new BadRequestException(
          `Daily withdrawal limit reached (${maxCount} withdrawals per 24 hours)`,
        );
      }
      if (maxAmount > 0 && total + amount > maxAmount) {
        throw new BadRequestException(
          `Daily withdrawal amount limit is ${maxAmount.toLocaleString()} FARM per 24 hours`,
        );
      }
    }
  }

  private formatMpesaNumber(phone: string | null) {
    if (!phone) return phone || '';
    if (phone.startsWith('+254')) {
      return '0' + phone.substring(4);
    }
    return phone;
  }

  private resolveBankCode(bankName: string) {
    return bankName?.toUpperCase() ?? bankName;
  }
}
