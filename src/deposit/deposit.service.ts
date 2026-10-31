import { cleanTransactionDescription } from '../common/utils/transaction-description';
// src/deposit/deposit.service.ts
import {
  Injectable,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import { FeesService } from '../fees/fees.service';
import { computeFee, ruleFor } from '../fees/fee-defaults';
import { PrismaService } from '../database/prisma.service';
import { PaystackService } from '../paystack/paystack.service';
import { IvorypayService } from '../ivorypay/ivorypay.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { v4 as uuidv4 } from 'uuid';
import { CacheService } from '../common/cache/cache.service';
import { assertResourceAccess } from '../common/utils/access-control.util';
import { NotificationsService } from '../notifications/notifications.service';
import { CurrencyConversionService } from '../currency/currency-conversion.service';
import { NowpaymentsService } from '../nowpayments/nowpayments.service';
import { Cron, CronExpression } from '@nestjs/schedule';

const MIN_NOWPAYMENTS_CRYPTO_DEPOSIT_USD = 2;
const STALE_NOWPAYMENTS_DEPOSIT_MS = 24 * 60 * 60 * 1000;
const NOWPAYMENTS_DEAD_STATUSES = new Set(['expired', 'failed', 'refunded']);

@Injectable()
export class DepositService {
  private readonly logger = new Logger(DepositService.name);

  constructor(
    private prisma: PrismaService,
    private paystack: PaystackService,
    private ivorypay: IvorypayService,
    private websocket: WebsocketGateway,
    private cache: CacheService,
    private notificationsService: NotificationsService,
    private readonly currencyConversion: CurrencyConversionService,
    private readonly nowpayments: NowpaymentsService,
    @Optional() private readonly fees?: FeesService,
  ) {}

  async getNowpaymentsCurrencies() {
    const currencies = await this.nowpayments.getAvailableCurrencies();
    return { data: currencies };
  }

  async estimateUsdCrypto(amountUsd: number, currency: string) {
    return this.nowpayments.estimateCheckout(amountUsd, currency);
  }

  async getNowpaymentsCryptoMinimum(currency: string) {
    const normalizedCurrency = currency.trim().toLowerCase();
    const currencies = await this.nowpayments.getAvailableCurrencies();
    if (!currencies.includes(normalizedCurrency)) {
      throw new BadRequestException(
        'The selected cryptocurrency is not currently available',
      );
    }
    const minimum =
      await this.nowpayments.getMinimumPaymentAmount(normalizedCurrency);
    return { data: minimum };
  }

  async getNowpaymentsCryptoEstimate(
    currency: string,
    priceAmount: string | number,
  ) {
    const normalizedCurrency = currency.trim().toLowerCase();
    const normalizedAmount = Number(priceAmount);
    if (
      !Number.isFinite(normalizedAmount) ||
      normalizedAmount <= 0 ||
      normalizedAmount > 100_000
    ) {
      throw new BadRequestException('Enter a valid USD amount');
    }

    const currencies = await this.nowpayments.getAvailableCurrencies();
    if (!currencies.includes(normalizedCurrency)) {
      throw new BadRequestException(
        'The selected cryptocurrency is not currently available',
      );
    }

    const [estimatedAmount, minimum] = await Promise.all([
      this.nowpayments.estimateAmount(
        normalizedAmount,
        'usd',
        normalizedCurrency,
      ),
      this.nowpayments.getMinimumPaymentAmount(normalizedCurrency),
    ]);

    return {
      data: {
        currency: normalizedCurrency,
        priceAmount: normalizedAmount,
        estimatedAmount,
        minimumAmount: minimum.minimumAmount,
        minimumUsd: minimum.minimumUsd,
        minimumDepositUsd: Math.max(
          MIN_NOWPAYMENTS_CRYPTO_DEPOSIT_USD,
          minimum.minimumUsd,
        ),
      },
    };
  }

  async createNowpaymentsCryptoDeposit(
    userId: string,
    dto: {
      price_amount: number;
      price_currency: string;
      pay_currency: string;
    },
  ) {
    const priceAmount = Number(dto.price_amount);
    const priceCurrency = dto.price_currency?.trim().toLowerCase();
    const payCurrency = dto.pay_currency?.trim().toLowerCase();
    if (
      !Number.isFinite(priceAmount) ||
      priceAmount < MIN_NOWPAYMENTS_CRYPTO_DEPOSIT_USD ||
      priceCurrency !== 'usd'
    ) {
      throw new BadRequestException(
        `Crypto deposits must be at least USD ${MIN_NOWPAYMENTS_CRYPTO_DEPOSIT_USD.toFixed(2)}`,
      );
    }
    if (!/^[a-z0-9]{2,20}$/.test(payCurrency ?? '')) {
      throw new BadRequestException('Choose a valid NOWPayments currency');
    }
    const currencies = await this.nowpayments.getAvailableCurrencies();
    if (!currencies.includes(payCurrency)) {
      throw new BadRequestException(
        'The selected cryptocurrency is not currently available',
      );
    }
    const minimum = await this.nowpayments.getMinimumPaymentAmount(payCurrency);
    const estimatedCryptoAmount = await this.nowpayments.estimateAmount(
      priceAmount,
      'usd',
      payCurrency,
    );
    if (estimatedCryptoAmount < minimum.minimumAmount) {
      throw new BadRequestException(
        `NOWPayments requires at least ${minimum.minimumAmount} ${payCurrency.toUpperCase()}. Increase the USD deposit amount for this currency.`,
      );
    }

    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: userId, is_active: true },
    });
    if (!wallet) {
      throw new BadRequestException('Active wallet not found');
    }
    const amountFarm = await this.currencyConversion.usdToFarm(priceAmount);
    if (!Number.isFinite(amountFarm) || amountFarm <= 0) {
      throw new BadRequestException(
        'The USD/FARM exchange rate is unavailable',
      );
    }

    const reference = uuidv4();
    const rate = await this.currencyConversion.getCurrentRate();
    const deposit = await this.prisma.$transaction(async (tx) => {
      const createdDeposit = await tx.deposit.create({
        data: {
          userId,
          amount: amountFarm,
          fee: 0,
          total: amountFarm,
          currency: 'FARM',
          paymentMethod: 'CRYPTO',
          provider: 'nowpayments',
          reference,
          status: 'PENDING',
        },
      });
      await tx.transactions.create({
        data: {
          transaction_reference: reference,
          receiver_wallet_id: wallet.id,
          transaction_type: 'deposit',
          status: 'pending',
          amount: amountFarm,
          fee: 0,
          net_amount: amountFarm,
          currency: 'FARM',
          description: `Crypto deposit via NOWPayments (${priceAmount.toFixed(2)} USD)`,
          metadata: {
            provider: 'nowpayments',
            payment_method: 'CRYPTO',
            user_id: userId,
            order_id: reference,
            amount_farm: amountFarm,
            amount_usd: priceAmount,
            currency_fiat: 'USD',
            pay_currency: payCurrency,
            farm_usd_rate: rate.farm_usd_rate,
          },
        },
      });
      return createdDeposit;
    });

    try {
      const payment = await this.nowpayments.createPayment({
        priceAmount,
        priceCurrency,
        payCurrency,
        orderId: reference,
        description: `FARM crypto deposit ${reference}`,
      });
      await this.prisma.$transaction([
        this.prisma.deposit.update({
          where: { id: deposit.id },
          data: { providerRef: payment.payment_id },
        }),
        this.prisma.transactions.update({
          where: { transaction_reference: reference },
          data: {
            metadata: {
              provider: 'nowpayments',
              payment_method: 'CRYPTO',
              user_id: userId,
              order_id: reference,
              nowpayments_payment_id: payment.payment_id,
              nowpayments_payment_status:
                payment.payment_status?.toString() ?? 'waiting',
              nowpayments_address: payment.pay_address,
              nowpayments_amount: payment.pay_amount,
              nowpayments_currency: payment.pay_currency,
              amount_farm: amountFarm,
              amount_usd: priceAmount,
              currency_fiat: priceCurrency,
              pay_currency: payCurrency,
              farm_usd_rate: rate.farm_usd_rate,
            },
          },
        }),
      ]);

      await this.prisma.audit_logs.create({
        data: {
          user_id: userId,
          action: 'deposit_initiated',
          entity_type: 'transaction',
          new_values: {
            reference,
            provider: 'nowpayments',
            amount_usd: priceAmount,
            amount_farm: amountFarm,
            pay_currency: payment.pay_currency,
          },
        },
      });

      return {
        data: {
          ...payment,
          reference,
          order_id: reference,
          amount_farm: amountFarm,
          status: 'waiting',
        },
        message: 'Crypto deposit initiated via NOWPayments',
      };
    } catch (error) {
      await this.prisma.$transaction([
        this.prisma.deposit.update({
          where: { id: deposit.id },
          data: { status: 'FAILED' },
        }),
        this.prisma.transactions.update({
          where: { transaction_reference: reference },
          data: {
            status: 'failed',
            metadata: {
              provider: 'nowpayments',
              payment_method: 'CRYPTO',
              user_id: userId,
              order_id: reference,
              amount_farm: amountFarm,
              amount_usd: priceAmount,
              pay_currency: payCurrency,
              nowpayments_initialization_error:
                error instanceof Error ? error.message : 'Provider error',
            },
          },
        }),
      ]);
      throw error;
    }
  }

  async getNowpaymentsCryptoDepositStatus(userId: string, paymentId: string) {
    if (!/^\d+$/.test(paymentId)) {
      throw new BadRequestException('Invalid NOWPayments payment ID');
    }
    const transaction = await this.prisma.transactions.findFirst({
      where: {
        metadata: { path: ['nowpayments_payment_id'], equals: paymentId },
        transaction_type: 'deposit',
      },
    });
    const metadata =
      (transaction?.metadata as Record<string, unknown> | null) ?? {};
    if (
      !transaction ||
      metadata.provider !== 'nowpayments' ||
      metadata.user_id !== userId
    ) {
      throw new BadRequestException('Crypto deposit was not found');
    }

    const payment = await this.nowpayments.getPayment(paymentId);
    const orderId = payment.order_id?.toString();
    const paymentStatus = payment.payment_status?.toString().toLowerCase();
    const expectedAmount = Number(metadata.amount_usd);
    const verifiedAmount = Number(payment.price_amount);
    if (
      orderId !== transaction.transaction_reference ||
      payment.pay_currency?.toString().toLowerCase() !==
        String(metadata.pay_currency).toLowerCase() ||
      payment.price_currency?.toString().toLowerCase() !== 'usd' ||
      !Number.isFinite(expectedAmount) ||
      !Number.isFinite(verifiedAmount) ||
      Math.abs(expectedAmount - verifiedAmount) > 0.01
    ) {
      throw new BadRequestException(
        'NOWPayments status did not match the pending deposit',
      );
    }

    await this.prisma.transactions.update({
      where: { id: transaction.id },
      data: {
        metadata: {
          ...metadata,
          nowpayments_payment_status: paymentStatus ?? 'unknown',
          nowpayments_last_checked_at: new Date().toISOString(),
        },
      },
    });

    let credited = false;
    if (['finished', 'confirmed'].includes(paymentStatus ?? '')) {
      credited = await this.finalizeSuccessfulDeposit(
        transaction.transaction_reference,
      );
    } else if (
      ['failed', 'refunded', 'expired'].includes(paymentStatus ?? '')
    ) {
      await this.prisma.$transaction([
        this.prisma.deposit.updateMany({
          where: {
            reference: transaction.transaction_reference,
            status: 'PENDING',
          },
          data: { status: 'FAILED' },
        }),
        this.prisma.transactions.updateMany({
          where: {
            id: transaction.id,
            status: { in: ['pending', 'processing'] },
          },
          data: { status: 'failed', processed_at: new Date() },
        }),
      ]);
    }

    return {
      data: {
        payment_id: paymentId,
        reference: transaction.transaction_reference,
        status: paymentStatus ?? 'unknown',
        credited,
      },
    };
  }

  async createDeposit(userId: string, dto: any) {
    const paymentMethod = (
      dto.paymentMethod ||
      dto.payment_method ||
      dto.method ||
      dto.payment_channel ||
      dto.payment_provider ||
      'CARD'
    ).toUpperCase();

    if (paymentMethod === 'CRYPTO') {
      this.logger.log(
        `DepositService: crypto deposit requested through the standard deposit endpoint for user=${userId}`,
      );
      throw new BadRequestException(
        'Crypto deposits must use the NOWPayments endpoint /api/v1/wallet/deposit/crypto',
      );
    }

    const amount = Number(dto.amount_fiat);
    if (!Number.isFinite(amount) || amount < 10) {
      throw new BadRequestException(
        `Invalid deposit amount. Minimum deposit is 10 ${dto.currency || 'KES'}`,
      );
    }

    if (
      paymentMethod === 'BANK_TRANSFER' &&
      (dto.currency || 'KES').toUpperCase() !== 'KES'
    ) {
      throw new BadRequestException('Paystack Pesalink deposits must use KES.');
    }

    const reference = uuidv4();
    const provider = 'paystack';
    // Deposits credit and charge exactly the amount entered by the user.
    const fee = 0;
    const total = amount;

    const depositCurrency =
      paymentMethod === 'CRYPTO'
        ? 'FARM'
        : paymentMethod === 'BANK_TRANSFER'
          ? 'KES'
          : dto.currency || 'KES';
    const depositAmount = amount;
    const depositFee = paymentMethod === 'CRYPTO' ? 0 : fee;
    const depositTotal = paymentMethod === 'CRYPTO' ? amount : total;

    const bankTransferInitialization =
      paymentMethod === 'BANK_TRANSFER'
        ? await this.paystack.initializePayment({
            email: dto.email || `${userId}@farm.app`,
            amount: total,
            reference,
            currency: 'KES',
            channels: ['bank_transfer'],
            metadata: { userId, paymentMethod },
          })
        : null;

    let providerRef = reference;
    const deposit = await this.prisma.deposit.create({
      data: {
        userId,
        amount: depositAmount,
        fee: depositFee,
        total: depositTotal,
        currency: depositCurrency,
        paymentMethod,
        provider,
        reference,
        status: 'PENDING',
        providerRef,
      },
    });

    const createdAmount = deposit.amount;
    let paymentUrl: string | null = null;
    let paystackAccessCode: string | null = null;

    if (paymentMethod !== 'CRYPTO') {
      await this.prisma.transactions.create({
        data: {
          transaction_reference: reference,
          transaction_type: 'deposit',
          status: 'pending',
          amount: total,
          fee: 0,
          net_amount: total,
          currency: depositCurrency,
          description: cleanTransactionDescription(
            `${paymentMethod} deposit via ${provider.toUpperCase()} (${depositCurrency} ${total})`,
          ) as string,
          metadata: {
            provider,
            amount_fiat: amount,
            currency_fiat: dto.currency || 'KES',
            exchange_rate: 1,
            user_id: userId,
            payment_method: paymentMethod,
            deposit_id: deposit.id,
          },
        },
      });
    }

    if (paymentMethod === 'CRYPTO') {
      const farmAmount = depositAmount;
      const farmToUsdRate = 130;
      const amountUsd = Number((farmAmount / farmToUsdRate).toFixed(2));

      const init = await this.ivorypay.createPayment({
        amount: amountUsd,
        currency: 'USD',
        reference,
        email: dto.email || `${userId}@farm.app`,
        description: `Farm deposit ${farmAmount.toFixed(4)} FARM → ${amountUsd.toFixed(2)} USD`,
        baseFiat: 'USD',
        metadata: {
          provider: 'ivorypay',
          amount_farm: farmAmount,
          amount_usd: amountUsd,
          farm_to_usd_rate: farmToUsdRate,
          currency_fiat: 'USD',
          user_id: userId,
          payment_method: 'CRYPTO',
        },
      });
      providerRef =
        init.providerReference ??
        init.data?.id ??
        init.data?.reference ??
        reference;
      if (providerRef !== reference) {
        await this.prisma.deposit.update({
          where: { id: deposit.id },
          data: { providerRef },
        });
      }
      paymentUrl =
        init.data?.payment_link || init.payment_link || init.checkout_url;

      await this.prisma.transactions.create({
        data: {
          transaction_reference: reference,
          transaction_type: 'deposit',
          status: 'pending',
          amount: farmAmount,
          fee: 0,
          net_amount: farmAmount,
          currency: 'FARM',
          description: `Crypto deposit via Ivorypay (${farmAmount} FARM → ${amountUsd} USD)`,
          metadata: {
            provider: 'ivorypay',
            provider_ref: providerRef,
            amount_farm: farmAmount,
            amount_usd: amountUsd,
            farm_to_usd_rate: farmToUsdRate,
            currency_fiat: 'USD',
            user_id: userId,
            payment_method: 'CRYPTO',
          },
        },
      });

      await this.prisma.audit_logs.create({
        data: {
          user_id: userId,
          action: 'deposit_initiated',
          entity_type: 'transaction',
          entity_id: null,
          new_values: {
            reference,
            amount_fiat: dto.amount_fiat,
            amount_farm: farmAmount,
          },
        },
      });

      return {
        data: {
          provider: 'IVORYPAY',
          reference,
          payment_url: init.data?.payment_link || init.payment_link,
          authorization_url: init.data?.payment_link || init.payment_link,
        },
        message: 'Crypto deposit initiated via Ivorypay',
      };
    } else if (paymentMethod === 'MOBILE_MONEY') {
      if (!dto.phone) {
        throw new BadRequestException(
          'Phone number is required for mobile money deposits',
        );
      }

      const init = await this.paystack.initializePayment({
        email: dto.email || `${userId}@farm.app`,
        amount: total,
        reference,
        currency: 'KES',
        channels: ['mobile_money'],
        phone: dto.phone,
        metadata: { userId, depositId: deposit.id, paymentMethod },
      });
      paymentUrl = init.authorization_url || init.authorizationUrl;
      paystackAccessCode = init.access_code || null;
    } else if (paymentMethod === 'CARD') {
      const init = await this.paystack.initializePayment({
        email: dto.email || `${userId}@farm.app`,
        amount: total,
        reference,
        currency: 'KES',
        channels: ['card'],
        metadata: { userId, depositId: deposit.id, paymentMethod },
      });
      paymentUrl = init.authorization_url || init.authorizationUrl;
      paystackAccessCode = init.access_code || null;
    } else if (paymentMethod === 'BANK_TRANSFER') {
      if (!bankTransferInitialization) {
        throw new Error('Paystack bank checkout was not initialized.');
      }
      const init = bankTransferInitialization;
      paymentUrl = init.authorization_url || init.authorizationUrl;
      paystackAccessCode = init.access_code || null;
    } else {
      throw new BadRequestException(
        `Unsupported payment method ${paymentMethod}`,
      );
    }

    return {
      success: true,
      payment_url: paymentUrl,
      authorization_url: paymentUrl,
      access_code: paystackAccessCode,
      reference,
      deposit,
    };
  }

  async getUserDeposits(userId: string) {
    // Return only successfully completed deposits to users.
    // Failed, pending or processing deposits are intentionally hidden
    // so the frontend shows only confirmed funds the webhook has validated.
    return this.prisma.deposit.findMany({
      where: { userId, status: 'SUCCESS' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getWalletBalance(userId: string) {
    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: userId, is_active: true },
    });
    return {
      balance: wallet?.balance ?? 0,
      locked_balance: wallet?.locked_balance ?? 0,
    };
  }

  async getDepositById(id: string, userId?: string) {
    const deposit = await this.prisma.deposit.findUnique({ where: { id } });
    if (!deposit) return null;
    assertResourceAccess(deposit.userId, userId, 'deposit');
    if (deposit.status !== 'SUCCESS') return null;
    return deposit;
  }

  async getDepositStatus(userId: string, reference: string) {
    const deposit = await this.prisma.deposit.findFirst({
      where: { reference },
    });
    if (deposit) assertResourceAccess(deposit.userId, userId, 'deposit');
    const transaction = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
      select: { status: true, transaction_type: true, metadata: true },
    });
    if (!deposit && (transaction as any)?.metadata?.user_id !== userId) {
      throw new BadRequestException('Deposit not found');
    }
    if (!deposit && !transaction)
      throw new BadRequestException('Deposit not found');
    return {
      data: {
        reference,
        status:
          deposit?.status ?? transaction?.status?.toUpperCase() ?? 'PENDING',
        amount: Number(deposit?.amount ?? 0),
        currency: deposit?.currency ?? 'FARM',
      },
    };
  }

  async verifyDepositStatus(userId: string, reference: string) {
    const deposit = await this.prisma.deposit.findFirst({
      where: { reference },
    });
    if (deposit) assertResourceAccess(deposit.userId, userId, 'deposit');
    const transaction = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
    });
    if (!deposit && (transaction?.metadata as any)?.user_id !== userId) {
      throw new BadRequestException('Deposit not found');
    }
    if (!deposit && !transaction)
      throw new BadRequestException('Deposit not found');
    const completed = await this.finalizeSuccessfulDeposit(reference);
    return {
      data: {
        reference,
        status: completed
          ? 'SUCCESS'
          : (deposit?.status ??
            transaction?.status?.toUpperCase() ??
            'PENDING'),
        credited: completed,
      },
    };
  }

  async finalizeMerchantQrPayment(reference: string) {
    const transaction = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
    });
    const metadata =
      (transaction?.metadata as Record<string, unknown> | null) ?? {};
    if (!transaction || metadata.qr_guest_payment !== true) return false;
    if (transaction.status?.toLowerCase() !== 'completed') return false;
    const result = await this.prisma.qr_payments.updateMany({
      where: { transaction_id: transaction.id, status: { not: 'completed' } },
      data: { status: 'completed' },
    });
    return (
      result.count > 0 ||
      !!(await this.prisma.qr_payments.findFirst({
        where: { transaction_id: transaction.id, status: 'completed' },
        select: { id: true },
      }))
    );
  }

  // Called ONLY from webhook
  async finalizeSuccessfulDeposit(reference: string) {
    this.logger.log(
      `finalizeSuccessfulDeposit: start for reference=${reference}`,
    );
    let deposit = await this.prisma.deposit.findFirst({ where: { reference } });
    const transaction = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
    });

    if (!transaction) {
      throw new BadRequestException(
        `Transaction not found for reference: ${reference}`,
      );
    }
    const transactionMetadata =
      (transaction.metadata as Record<string, unknown> | null) ?? {};

    // Extra guard: verify provider's authoritative status for this reference
    try {
      const metadata = transactionMetadata;
      const provider = (
        metadata?.provider?.toString()?.toLowerCase() ||
        deposit?.provider?.toLowerCase() ||
        'unknown'
      ).trim();
      if (provider === 'paystack') {
        try {
          const verified = await this.paystack.verifyTransaction(reference);
          if (
            !verified ||
            (verified.status ?? '').toString().toLowerCase() !== 'success'
          ) {
            this.logger.warn(
              `finalizeSuccessfulDeposit: paystack verify indicates non-success for ${reference} status=${verified?.status ?? 'unknown'} - aborting credit`,
            );
            return false;
          }
        } catch (e) {
          this.logger.warn(
            `finalizeSuccessfulDeposit: paystack verify failed for ${reference} - aborting credit`,
            e,
          );
          return false;
        }
      } else if (provider === 'nowpayments') {
        const paymentId = String(metadata.nowpayments_payment_id ?? '');
        try {
          const verified = await this.nowpayments.getPayment(paymentId);
          const expectedUsd = Number(metadata.amount_usd);
          const actualUsd = Number(verified.price_amount);
          if (
            !['finished', 'confirmed'].includes(
              verified.payment_status?.toString().toLowerCase() ?? '',
            ) ||
            verified.order_id?.toString() !== reference ||
            verified.price_currency?.toString().toLowerCase() !== 'usd' ||
            verified.pay_currency?.toString().toLowerCase() !==
              String(
                metadata.pay_currency ?? metadata.crypto ?? '',
              ).toLowerCase() ||
            !Number.isFinite(expectedUsd) ||
            !Number.isFinite(actualUsd) ||
            Math.abs(expectedUsd - actualUsd) > 0.01
          ) {
            this.logger.warn(
              `NOWPayments verification did not match successful deposit ref=${reference}`,
            );
            return false;
          }
        } catch (error) {
          this.logger.warn(
            `NOWPayments verification failed for ${reference}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return false;
        }
      }
    } catch (e) {
      if (transactionMetadata.provider === 'nowpayments') {
        this.logger.error(
          `NOWPayments verification could not be completed for ${reference}`,
        );
        return false;
      }
      this.logger.debug(
        'finalizeSuccessfulDeposit: provider verification skipped due to error',
        e,
      );
    }

    if (!deposit && transaction?.amount) {
      const metadata = transaction.metadata as any;
      const userId = metadata?.user_id;
      const metadataProvider = metadata?.provider?.toString()?.toLowerCase();
      const paymentMethod = ['ivorypay', 'nowpayments'].includes(
        metadataProvider,
      )
        ? 'CRYPTO'
        : 'CARD';
      if (!userId) {
        this.logger.warn(
          `Deposit missing for reference ${reference} but transaction metadata.user_id is unavailable`,
        );
      } else {
        this.logger.warn(
          `Deposit missing for reference ${reference}, reconstructing from transaction`,
        );
        deposit = await this.prisma.deposit.create({
          data: {
            reference,
            amount: Number(transaction.amount),
            fee: 0,
            total: Number(transaction.amount),
            currency: transaction.currency || 'FARM',
            paymentMethod,
            provider: ['ivorypay', 'nowpayments'].includes(metadataProvider)
              ? metadataProvider
              : 'paystack',
            status: 'PENDING',
            userId,
          },
        });
      }
    }

    const depositPending = !!deposit && deposit.status === 'PENDING';
    const depositComplete = !!deposit && deposit.status === 'SUCCESS';
    const isDeposit = transaction.transaction_type?.toLowerCase() === 'deposit';
    const txStatus = transaction.status?.toLowerCase();
    const txPending =
      isDeposit && ['pending', 'processing'].includes(txStatus ?? '');
    const txComplete = isDeposit && txStatus === 'completed';
    const txFailed =
      isDeposit &&
      [
        'failed',
        'cancelled',
        'reversed',
        'abandoned',
        'expired',
        'incomplete',
        'declined',
      ].includes(txStatus ?? '');
    const txUnknown =
      isDeposit &&
      ![
        'pending',
        'processing',
        'completed',
        'failed',
        'cancelled',
        'reversed',
        'abandoned',
        'expired',
        'incomplete',
        'declined',
      ].includes(txStatus ?? '');

    if (txFailed || txUnknown) {
      this.logger.warn(
        `finalizeSuccessfulDeposit: transaction ${reference} status=${transaction.status} - not crediting wallet`,
      );
      return false;
    }

    if (transactionMetadata.qr_guest_payment === true) {
      if (
        txStatus === 'completed' &&
        (transactionMetadata.platform_fee_type === 'merchant_sale' ||
          depositComplete)
      ) {
        return true;
      }
      if (!deposit || !depositPending || (!txPending && !txComplete)) {
        this.logger.warn(
          `finalizeSuccessfulDeposit: merchant QR payment ${reference} is not eligible for settlement`,
        );
        return false;
      }
      return this.finalizeMerchantQrDeposit(reference, deposit, transaction);
    }

    if (depositComplete && txComplete) {
      this.logger.log(
        `finalizeSuccessfulDeposit: already completed for ${reference}`,
      );
      return true;
    }

    if (depositPending && txPending) {
      return this.finalizePendingDepositWithTransaction(
        reference,
        deposit!,
        transaction,
      );
    }

    if (depositPending) {
      return this.creditPendingDepositWithWallet(
        reference,
        deposit!,
        transaction,
      );
    }

    if (depositComplete && txPending) {
      return this.completePendingTransaction(reference, transaction);
    }

    if (txPending) {
      return this.creditPendingTransactionDeposit(reference);
    }

    this.logger.warn(
      `finalizeSuccessfulDeposit: transaction ${reference} status=${transaction.status} is not eligible for wallet credit`,
    );
    return false;
  }

  private async finalizeMerchantQrDeposit(
    reference: string,
    deposit: any,
    transaction: any,
  ) {
    const metadata =
      (transaction.metadata as Record<string, unknown> | null) ?? {};
    const merchantId = metadata.merchant_id;
    if (typeof merchantId !== 'string' || !merchantId) {
      throw new BadRequestException(
        `Merchant QR payment ${reference} is missing its merchant`,
      );
    }

    const merchantRule = await ruleFor(this.fees, 'merchant');
    const result = await this.prisma.$transaction(async (tx) => {
      const merchant = await tx.merchants.findUnique({
        where: { id: merchantId },
        select: { id: true, user_id: true, business_name: true },
      });
      if (!merchant?.user_id || merchant.user_id !== deposit.userId) {
        throw new BadRequestException(
          `Merchant QR payment ${reference} does not match its merchant wallet`,
        );
      }

      const merchantWallet = await tx.wallets.findFirst({
        where: {
          user_id: merchant.user_id,
          wallet_type: 'user',
          is_active: true,
        },
      });
      if (!merchantWallet) {
        throw new BadRequestException(
          `Merchant wallet not found for QR payment ${reference}`,
        );
      }

      const superadmin = await tx.users.findFirst({
        where: { role: 'super_admin', is_deleted: false },
        include: { wallets: { where: { is_active: true }, take: 1 } },
      });
      const superadminWallet = superadmin?.wallets[0];
      if (!superadmin || !superadminWallet) {
        throw new BadRequestException('Superadmin wallet not found');
      }

      const updatedDeposit = await tx.deposit.updateMany({
        where: { id: deposit.id, status: 'PENDING' },
        data: { status: 'SUCCESS' },
      });
      if (updatedDeposit.count === 0) {
        return { ok: false as const };
      }

      const amount = this.normalizeAmount(Number(deposit.amount));
      const fee = this.normalizeAmount(computeFee(merchantRule, amount, 8));
      const merchantNet = this.normalizeAmount(amount - fee);
      const merchantBalanceBefore = this.normalizeAmount(
        Number(merchantWallet.balance ?? 0),
      );
      const superadminBalanceBefore = this.normalizeAmount(
        Number(superadminWallet.balance ?? 0),
      );
      const settledMetadata = {
        ...metadata,
        platform_fee_type: 'merchant_sale',
        platform_fee_percent: merchantRule.percent,
        platform_fee: fee,
      };

      await tx.wallets.update({
        where: { id: merchantWallet.id },
        data: { balance: { increment: merchantNet } },
      });
      const updatedSuperadminWallet = await tx.wallets.update({
        where: { id: superadminWallet.id },
        data: { balance: { increment: fee } },
      });
      await tx.transactions.update({
        where: { id: transaction.id },
        data: {
          transaction_type: 'merchant_payment',
          status: 'completed',
          fee,
          net_amount: merchantNet,
          receiver_wallet_id: merchantWallet.id,
          metadata: settledMetadata,
          processed_at: new Date(),
        },
      });
      await tx.merchants.update({
        where: { id: merchant.id },
        data: { total_sales: { increment: amount } },
      });
      await tx.qr_payments.updateMany({
        where: { transaction_id: transaction.id, status: { not: 'completed' } },
        data: { status: 'completed' },
      });
      await tx.ledger_entries.createMany({
        data: [
          {
            transaction_id: transaction.id,
            wallet_id: merchantWallet.id,
            entry_type: 'credit',
            amount: merchantNet,
            balance_before: merchantBalanceBefore,
            balance_after: merchantBalanceBefore + merchantNet,
            description: `Merchant QR sale received after 1% platform fee — ref: ${reference}`,
          },
          {
            transaction_id: transaction.id,
            wallet_id: superadminWallet.id,
            entry_type: 'credit',
            amount: fee,
            balance_before: superadminBalanceBefore,
            balance_after: superadminBalanceBefore + fee,
            description: `1% platform fee from merchant QR sale — ref: ${reference}`,
          },
        ],
      });

      return {
        ok: true as const,
        merchantId: merchant.user_id,
        merchantBalance: merchantBalanceBefore + merchantNet,
        superadminId: superadmin.id,
        superadminBalance: Number(updatedSuperadminWallet.balance),
        amount,
        fee,
        merchantNet,
      };
    });

    if (!result.ok) return false;

    try {
      this.websocket.emitBalanceUpdate(
        result.merchantId,
        result.merchantBalance,
      );
      this.websocket.emitBalanceUpdate(
        result.superadminId,
        result.superadminBalance,
      );
    } catch (error) {
      this.logger.warn(
        `Merchant QR balance update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      await Promise.all([
        this.invalidateFinancialCaches(result.merchantId),
        this.invalidateFinancialCaches(result.superadminId),
      ]);
    } catch (error) {
      this.logger.error(
        `Merchant QR cache invalidation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    try {
      await this.notificationsService.sendNotification(result.merchantId, {
        type: 'merchant',
        entityId: reference,
        title: 'Merchant payment received',
        body: `You received ${result.merchantNet} FARM after the 1% sales fee.`,
        metadata: {
          merchant_id: metadata.merchant_id,
          amount: result.amount,
          fee: result.fee,
          net_amount: result.merchantNet,
          event: 'merchant_payment_received',
        },
      });
    } catch (error) {
      this.logger.error(
        `Merchant QR payment notification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return true;
  }

  async failDeposit(reference: string, reason?: string) {
    const deposit = await this.prisma.deposit.findFirst({
      where: { reference },
    });
    const transaction = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
    });

    if (!deposit && !transaction) {
      this.logger.warn(
        `failDeposit: no deposit or transaction found for reference=${reference}`,
      );
      return false;
    }

    const metadata = (transaction?.metadata as any) ?? {};
    const failureMetadata = {
      ...metadata,
      failure_reason: reason ?? metadata.failure_reason,
    };

    await this.prisma.$transaction(async (tx) => {
      if (deposit && deposit.status === 'PENDING') {
        await tx.deposit.update({
          where: { id: deposit.id },
          data: { status: 'FAILED' },
        });
      }

      if (
        transaction &&
        !['failed', 'cancelled', 'completed'].includes(
          transaction.status?.toLowerCase() ?? '',
        )
      ) {
        await tx.transactions.update({
          where: { id: transaction.id },
          data: {
            status: 'failed',
            processed_at: new Date(),
            metadata: failureMetadata,
          },
        });
      }
    });

    this.logger.log(
      `failDeposit: marked ${reference} as failed${reason ? ` reason=${reason}` : ''}`,
    );

    // Emit websocket update so frontend clients can react in real-time
    try {
      const metadata2 = (transaction?.metadata as any) ?? {};
      const userId = deposit?.userId ?? metadata2?.user_id;
      if (userId) {
        this.websocket.emitTransactionUpdate(userId, {
          reference,
          status: 'FAILED',
          reason: failureMetadata.failure_reason ?? reason,
        });
        await this.notificationsService.sendNotification(userId, {
          type: 'transaction',
          title: 'Deposit failed',
          body: reason
            ? `Your deposit could not be completed: ${reason}`
            : 'Your deposit could not be completed.',
          entityId: reference,
          metadata: { reference },
        });
      }
    } catch (e) {
      this.logger.debug(
        'Failed to emit websocket update for failed deposit',
        e,
      );
    }

    return true;
  }

  private async finalizePendingDepositWithTransaction(
    reference: string,
    deposit: any,
    transaction: any,
  ) {
    if (!transaction || !transaction.id) {
      throw new BadRequestException(
        `Invalid transaction for deposit finalization: reference=${reference}`,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      let wallet = await tx.wallets.findFirst({
        where: { user_id: deposit.userId, is_active: true },
      });
      if (!wallet) {
        wallet = await tx.wallets.create({
          data: {
            user_id: deposit.userId,
            wallet_name: 'Main Wallet',
            wallet_type: 'user',
            wallet_address: uuidv4(),
            currency: deposit.currency || 'FARM',
          },
        });
      }

      const updatedDeposit = await tx.deposit.updateMany({
        where: { id: deposit.id, status: 'PENDING' },
        data: { status: 'SUCCESS' },
      });
      if (updatedDeposit.count === 0) {
        return { ok: false };
      }

      const amount = this.normalizeAmount(Number(deposit.amount));
      const previousBalance = this.normalizeAmount(Number(wallet.balance ?? 0));

      await tx.wallets.update({
        where: { id: wallet.id },
        data: { balance: { increment: amount } },
      });

      await tx.ledger_entries.create({
        data: {
          transaction_id: transaction.id,
          wallet_id: wallet.id,
          entry_type: 'credit',
          amount,
          balance_before: previousBalance,
          balance_after: previousBalance + amount,
          description: `Deposit completed — ref: ${reference}`,
        },
      });

      if (transaction.status?.toLowerCase() !== 'completed') {
        await tx.transactions.update({
          where: { id: transaction.id },
          data: {
            status: 'completed',
            receiver_wallet_id: transaction.receiver_wallet_id ?? wallet.id,
            processed_at: new Date(),
          },
        });
      }

      return { ok: true };
    });

    if (result.ok) {
      await this.invalidateFinancialCaches(deposit?.userId);
    }

    return result.ok;
  }

  private async completePendingTransaction(
    reference: string,
    transaction: any,
  ) {
    if (!transaction) {
      this.logger.warn(`Transaction not found for reference: ${reference}`);
      return false;
    }

    const txStatus = transaction.status?.toLowerCase();
    if (txStatus === 'completed') {
      return true;
    }

    if (!['pending', 'processing'].includes(txStatus ?? '')) {
      this.logger.warn(
        `completePendingTransaction: transaction ${reference} status=${transaction.status} cannot be completed automatically`,
      );
      return false;
    }

    const updates: any = {
      status: 'completed',
      processed_at: new Date(),
    };

    if (!transaction.receiver_wallet_id) {
      const deposit = await this.prisma.deposit.findFirst({
        where: { reference },
      });
      if (deposit) {
        const wallet = await this.prisma.wallets.findFirst({
          where: { user_id: deposit.userId, is_active: true },
        });
        if (wallet) updates.receiver_wallet_id = wallet.id;
      }
    }

    await this.prisma.transactions.update({
      where: { id: transaction.id },
      data: updates,
    });

    await this.invalidateFinancialCaches(
      transaction?.metadata?.user_id ?? undefined,
    );

    return true;
  }

  private async creditPendingTransactionDeposit(reference: string) {
    const transaction = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
    });
    if (!transaction) {
      this.logger.warn(`Transaction not found for reference: ${reference}`);
      return false;
    }

    const isDeposit = transaction.transaction_type?.toLowerCase() === 'deposit';
    if (!isDeposit) return false;
    const txStatus = transaction.status?.toLowerCase();
    if (txStatus === 'completed') return true;
    if (!['pending', 'processing'].includes(txStatus ?? '')) {
      this.logger.warn(
        `creditPendingTransactionDeposit: transaction ${reference} status=${transaction.status} is not eligible for credit`,
      );
      return false;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      let wallet: any = transaction.receiver_wallet_id
        ? await tx.wallets.findUnique({
            where: { id: transaction.receiver_wallet_id },
          })
        : null;

      const metadata = transaction.metadata as any;
      const userId = metadata?.user_id;
      if (!wallet && userId) {
        wallet = await tx.wallets.findFirst({
          where: { user_id: userId, is_active: true },
        });
      }

      if (!wallet && userId) {
        wallet = await tx.wallets.create({
          data: {
            user_id: userId,
            wallet_name: 'Main Wallet',
            wallet_type: 'user',
            wallet_address: uuidv4(),
            currency: transaction.currency || 'FARM',
          },
        });
      }

      if (!wallet) return { ok: false };

      const previousBalance = this.normalizeAmount(Number(wallet.balance ?? 0));
      const amount = this.normalizeAmount(Number(transaction.amount));

      const updated = await tx.transactions.updateMany({
        where: { id: transaction.id, status: { not: 'completed' } },
        data: {
          status: 'completed',
          receiver_wallet_id: wallet.id,
          processed_at: new Date(),
        },
      });
      if (updated.count === 0) return { ok: false };

      await tx.wallets.update({
        where: { id: wallet.id },
        data: { balance: { increment: amount } },
      });

      await tx.ledger_entries.create({
        data: {
          transaction_id: transaction.id,
          wallet_id: wallet.id,
          entry_type: 'credit',
          amount,
          balance_before: previousBalance,
          balance_after: previousBalance + amount,
          description: `Deposit completed — ref: ${reference}`,
        },
      });

      return { ok: true };
    });

    if (result.ok) {
      const metadata = (transaction?.metadata as any) ?? {};
      await this.invalidateFinancialCaches(metadata?.user_id ?? undefined);
      if (metadata?.user_id) {
        await this.notificationsService.sendNotification(metadata.user_id, {
          type: 'deposit_completed',
          title: 'Deposit completed',
          body: `Your deposit of ${Number(transaction.amount ?? 0)} ${transaction.currency || 'FARM'} has been credited to your wallet.`,
          entityId: transaction.id,
          metadata: {
            reference,
            amount: Number(transaction.amount ?? 0),
            currency: transaction.currency || 'FARM',
          },
        });
      }
    }

    return result.ok;
  }

  private async creditPendingDepositWithWallet(
    reference: string,
    deposit: any,
    transaction?: any,
  ) {
    if (!deposit || deposit.status !== 'PENDING') {
      this.logger.warn(
        `creditPendingDepositWithWallet: deposit not in PENDING state for ${reference}`,
      );
      return false;
    }

    if (!transaction) {
      transaction = await this.prisma.transactions.findUnique({
        where: { transaction_reference: reference },
      });
    }

    if (!transaction || transaction.status?.toLowerCase() !== 'pending') {
      this.logger.warn(
        `creditPendingDepositWithWallet: invalid transaction state for ${reference}. ` +
          `Transaction: ${transaction ? `exists, status=${transaction.status}` : 'missing'}`,
      );
      return false;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.deposit.updateMany({
        where: { id: deposit.id, status: 'PENDING' },
        data: { status: 'SUCCESS' },
      });
      if (updated.count === 0) return { ok: false };

      let wallet = await tx.wallets.findFirst({
        where: { user_id: deposit.userId, is_active: true },
      });
      if (!wallet) {
        wallet = await tx.wallets.create({
          data: {
            user_id: deposit.userId,
            wallet_name: 'Main Wallet',
            wallet_type: 'user',
            wallet_address: uuidv4(),
            currency: deposit.currency || 'FARM',
          },
        });
      }

      const previousBalance = this.normalizeAmount(Number(wallet.balance ?? 0));
      const amount = this.normalizeAmount(Number(deposit.amount));

      await tx.wallets.update({
        where: { id: wallet.id },
        data: { balance: { increment: amount } },
      });

      await tx.ledger_entries.create({
        data: {
          transaction_id: transaction.id,
          wallet_id: wallet.id,
          entry_type: 'credit',
          amount,
          balance_before: previousBalance,
          balance_after: previousBalance + amount,
          description: `Deposit completed — ref: ${reference}`,
        },
      });

      if (transaction.status?.toLowerCase() !== 'completed') {
        await tx.transactions.update({
          where: { id: transaction.id },
          data: {
            status: 'completed',
            receiver_wallet_id: wallet.id,
            processed_at: new Date(),
          },
        });
      }

      return { ok: true };
    });

    if (result.ok) {
      await this.invalidateFinancialCaches(deposit?.userId);
      if (deposit?.userId) {
        await this.notificationsService.sendNotification(deposit.userId, {
          type: 'deposit_completed',
          title: 'Deposit completed',
          body: `Your deposit of ${Number(deposit.amount ?? 0)} ${deposit.currency || 'FARM'} has been credited to your wallet.`,
          entityId: deposit.id,
          metadata: {
            amount: Number(deposit.amount ?? 0),
            currency: deposit.currency || 'FARM',
          },
        });
      }
    }

    return result.ok;
  }

  private async invalidateFinancialCaches(userId?: string) {
    if (!userId) return;

    await Promise.all([
      this.cache.cacheInvalidatePattern(`wallet:${userId}:balance`),
      this.cache.cacheInvalidatePattern(`dashboard:${userId}`),
      this.cache.cacheInvalidatePattern(`transactions:${userId}:*`),
      this.cache.cacheDelete('admin:dashboard:stats'),
      this.cache.cacheDelete('admin:analytics'),
      this.cache.cacheDelete('admin:superadmin-dashboard'),
    ]);
  }

  private normalizeAmount(amount: any): number {
    const n = Number(amount ?? 0);
    if (!isFinite(n)) return 0;
    return Math.round(n * 100) / 100;
  }

  /**
   * Off unless NOWPAYMENTS_EXPIRE_STALE_ENABLED=true. Marks NOWPayments
   * deposits that have been PENDING for more than 24h as FAILED, but only
   * when no payment can arrive: either NOWPayments never created a payment
   * (no providerRef), or NOWPayments itself reports it expired/failed/refunded.
   * Never credits or debits anything; status change only.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async expireStaleNowpaymentsDeposits() {
    if (process.env.NOWPAYMENTS_EXPIRE_STALE_ENABLED !== 'true') return;
    return this.runExpireStaleNowpaymentsDeposits();
  }

  async runExpireStaleNowpaymentsDeposits(now = new Date()) {
    const cutoff = new Date(now.getTime() - STALE_NOWPAYMENTS_DEPOSIT_MS);
    const stale = await this.prisma.deposit.findMany({
      where: {
        provider: 'nowpayments',
        status: 'PENDING',
        createdAt: { lt: cutoff },
      },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    let expired = 0;
    for (const d of stale) {
      let reason: string | null = null;
      if (!d.providerRef) {
        reason = 'nowpayments_payment_never_created';
      } else {
        try {
          const p = await this.nowpayments.getPayment(d.providerRef);
          const st = p.payment_status?.toString().toLowerCase() ?? '';
          if (NOWPAYMENTS_DEAD_STATUSES.has(st)) reason = `nowpayments_${st}`;
        } catch (err) {
          this.logger.warn(
            `Stale NOWPayments check failed for deposit ${d.id}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      }
      if (!reason) continue;
      const res = await this.prisma.$transaction(async (tx) => {
        const u = await tx.deposit.updateMany({
          where: { id: d.id, status: 'PENDING' },
          data: { status: 'FAILED' },
        });
        if (u.count === 1) {
          await tx.transactions.updateMany({
            where: { transaction_reference: d.reference, status: 'pending' },
            data: { status: 'failed' },
          });
        }
        return u.count;
      });
      if (res === 1) {
        expired += 1;
        this.logger.log(
          `Expired stale NOWPayments deposit ${d.id} (${reason})`,
        );
      }
    }
    return { checked: stale.length, expired };
  }
}
