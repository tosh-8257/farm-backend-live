import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { FeesService } from '../fees/fees.service';
import { computeFee, ruleFor } from '../fees/fee-defaults';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { CacheService } from '../common/cache/cache.service';
import { CurrencyConversionService } from '../currency/currency-conversion.service';
import { PrismaService } from '../database/prisma.service';
import { IvorypayService } from '../ivorypay/ivorypay.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaystackService } from '../paystack/paystack.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { PUBLIC_CHECKOUT_BASE_URL } from '../qr/merchant-checkout.constants';
import { CreateQrPaymentDto } from './create-qr-payment.dto';
import { NowpaymentsService } from '../nowpayments/nowpayments.service';

const DEFAULT_PUBLIC_PAY_SUCCESS_URL = `${PUBLIC_CHECKOUT_BASE_URL}/pay/success`;

type QrProvider = 'paystack' | 'ivorypay' | 'nowpayments';

import { settlementWalletFor } from '../business-ops/business-wallet';

@Injectable()
export class QrPaymentsService {
  private readonly logger = new Logger(QrPaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
    private readonly ivorypay: IvorypayService,
    private readonly currencyConversion: CurrencyConversionService,
    private readonly cache: CacheService,
    private readonly websocket: WebsocketGateway,
    private readonly notifications: NotificationsService,
    private readonly receipts: ReceiptsService,
    private readonly nowpayments: NowpaymentsService,
    @Optional() private readonly fees?: FeesService,
  ) {}

  async getPublicMerchant(merchantId: string) {
    if (
      merchantId === 'ANYID' ||
      merchantId.length < 10 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        merchantId,
      )
    ) {
      throw new BadRequestException('Invalid merchant ID from QR');
    }

    const merchant = await this.prisma.merchants.findUnique({
      where: { id: merchantId },
      include: {
        users_merchants_user_idTousers: {
          select: { first_name: true, last_name: true },
        },
      },
    });
    if (!merchant || merchant.status !== 'approved' || !merchant.user_id) {
      throw new NotFoundException(
        'Merchant not found or unable to accept payments',
      );
    }

    const owner = merchant.users_merchants_user_idTousers;
    const ownerName = [owner?.first_name, owner?.last_name]
      .filter((part) => typeof part === 'string' && part.trim())
      .join(' ');

    return {
      data: {
        id: merchant.id,
        farmName: merchant.business_name,
        ownerName: ownerName || merchant.business_name,
        avatar: merchant.business_logo,
        qrPayload: merchant.qr_code,
      },
    };
  }

  async getPublicCryptoOptions() {
    const tokens = await this.nowpayments.getAvailableCurrencies();
    const options = tokens.map((token) => ({
      token: token.toUpperCase(),
      network: token,
      networkName: token.toUpperCase(),
    }));
    return { data: { tokens, options } };
  }

  async initialize(dto: CreateQrPaymentDto) {
    const merchant = await this.prisma.merchants.findUnique({
      where: { id: dto.merchantId },
      include: {
        users_merchants_user_idTousers: {
          select: { id: true, email: true },
        },
      },
    });
    if (!merchant || merchant.status !== 'approved' || !merchant.user_id) {
      throw new NotFoundException(
        'Merchant not found or unable to accept payments',
      );
    }

    // BUSINESS_WALLET_ENABLED: settle into the business wallet (legacy: owner's personal wallet).
    const wallet = await settlementWalletFor(this.prisma, {
      merchantId: merchant.id,
      ownerUserId: merchant.user_id,
    });
    if (!wallet) {
      throw new BadRequestException(
        'This merchant does not have an active wallet',
      );
    }

    const rate = await this.currencyConversion.getCurrentRate();
    const kesPerFarm = Number(rate.farm_kes_rate);
    const farmPerKes =
      Number.isFinite(kesPerFarm) && kesPerFarm > 0 ? 1 / kesPerFarm : NaN;
    const amountFarm = dto.amount * farmPerKes;
    if (!Number.isFinite(amountFarm) || amountFarm <= 0) {
      throw new BadRequestException('The FARM exchange rate is unavailable');
    }

    const provider = (
      dto.method === 'crypto' ? 'nowpayments' : 'paystack'
    ) as QrProvider;
    const reference =
      provider === 'ivorypay'
        ? randomUUID()
        : `QR-${Date.now()}-${randomUUID()}`;
    const email =
      dto.guestEmail?.trim() ||
      merchant.business_email?.trim() ||
      merchant.users_merchants_user_idTousers?.email?.trim();
    if (!email) {
      throw new BadRequestException(
        'An email address is required for this payment',
      );
    }
    let amountUsd: number | undefined;
    let crypto: string | undefined;
    if (provider === 'nowpayments') {
      const availableTokens = await this.nowpayments.getAvailableCurrencies();
      crypto = (dto.crypto || 'usdttrc20').trim().toLowerCase();
      if (!availableTokens.includes(crypto)) {
        throw new BadRequestException(
          'The selected cryptocurrency is not currently available',
        );
      }
      const farmUsdRate = Number(rate.farm_usd_rate);
      if (!Number.isFinite(farmUsdRate) || farmUsdRate <= 0) {
        throw new BadRequestException(
          'The FARM/USD exchange rate is unavailable',
        );
      }
      amountUsd = Number((amountFarm * farmUsdRate).toFixed(2));
      if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
        throw new BadRequestException(
          'The payment amount is too small to convert to a positive USD amount',
        );
      }
    }

    const metadata: Prisma.InputJsonObject = {
      type: 'qr_sale',
      isQrSale: true,
      qr_guest_payment: true,
      merchant_id: merchant.id,
      merchantId: merchant.id,
      originalReference: reference,
      provider,
      provider_ref: reference,
      amount_fiat: dto.amount,
      amount_kes: dto.amount,
      amount_farm: amountFarm,
      currency_fiat: 'KES',
      user_id: merchant.user_id,
      payment_method: dto.method,
      guest_email: email,
      platform_fee_type: 'merchant_sale',
      platform_fee_percent: 1,
      ...(amountUsd !== undefined ? { amount_usd: amountUsd } : {}),
      ...(crypto ? { requested_crypto: crypto } : {}),
    };

    const transaction = await this.prisma.$transaction(async (tx) => {
      const created = await tx.transactions.create({
        data: {
          transaction_reference: reference,
          receiver_wallet_id: wallet.id,
          transaction_type: 'merchant_payment',
          status: 'pending',
          amount: amountFarm,
          fee: 0,
          net_amount: amountFarm,
          currency: 'FARM',
          description: `Public QR payment to ${merchant.business_name}`,
          exchange_rate: farmPerKes,
          metadata,
        },
      });
      await tx.qr_payments.create({
        data: {
          merchant_id: merchant.id,
          transaction_id: created.id,
          qr_payload: merchant.qr_code,
          amount: amountFarm,
          status: 'pending',
          scanned_at: new Date(),
        },
      });
      return created;
    });

    try {
      const callbackUrl = new URL(DEFAULT_PUBLIC_PAY_SUCCESS_URL);
      callbackUrl.searchParams.set('reference', reference);
      if (provider !== 'paystack') {
        callbackUrl.searchParams.set('farm_reference', reference);
      }
      let paymentUrl: string | undefined;
      let providerReference = reference;
      const providerMetadata: Record<string, string> = {
        provider_ref: reference,
      };

      if (provider === 'paystack') {
        const channels =
          dto.method === 'mpesa'
            ? ['mobile_money']
            : dto.method === 'bank'
              ? ['bank_transfer']
              : ['card'];
        const initialized = await this.paystack.initializePayment({
          email,
          amount: dto.amount,
          currency: 'KES',
          reference,
          channels,
          callback_url: callbackUrl.toString(),
          metadata: {
            type: 'qr_sale',
            merchantId: merchant.id,
            originalReference: reference,
            isQrSale: true,
          },
        });
        paymentUrl =
          initialized.authorization_url ?? initialized.authorizationUrl;
      } else if (provider === 'ivorypay') {
        const initialized = await this.ivorypay.createPayment({
          amount: amountUsd,
          currency: 'USD',
          reference,
          email,
          description: `QR merchant payment to ${merchant.business_name}`,
          baseFiat: 'USD',
          crypto,
          redirect_url: callbackUrl.toString(),
          metadata: {
            type: 'qr_sale',
            merchantId: merchant.id,
            originalReference: reference,
            isQrSale: true,
            amount_kes: dto.amount,
            amount_farm: amountFarm,
            amount_usd: amountUsd,
          },
        });
        paymentUrl = initialized.payment_link;
        providerReference =
          initialized.providerTransactionId ??
          initialized.providerReference ??
          reference;
        providerMetadata.provider_ref = providerReference;
        const identifierMetadataKeys: Record<string, string> = {
          transaction_id: 'provider_transaction_id',
          payment_id: 'provider_payment_id',
          checkout_id: 'provider_checkout_id',
          provider_reference: 'provider_reference',
          merchant_reference: 'provider_merchant_reference',
          invoice_id: 'provider_invoice_id',
          tx_ref: 'provider_tx_ref',
          trxref: 'provider_trxref',
          transaction_reference: 'provider_transaction_reference',
          payment_reference: 'payment_reference',
          id: 'provider_id',
        };
        for (const [identifierKey, metadataKey] of Object.entries(
          identifierMetadataKeys,
        )) {
          const identifier = initialized.providerIdentifiers?.[identifierKey];
          if (typeof identifier === 'string' && identifier.trim()) {
            providerMetadata[metadataKey] = identifier.trim();
          }
        }
      } else {
        const initialized = await this.nowpayments.createInvoice({
          priceAmount: amountUsd!,
          priceCurrency: 'usd',
          orderId: reference,
          description: `QR merchant payment to ${merchant.business_name}`,
          successUrl: callbackUrl.toString(),
          cancelUrl: callbackUrl.toString(),
        });
        paymentUrl = initialized.invoice_url;
        providerReference = initialized.invoice_id;
        providerMetadata.provider_ref = providerReference;
        providerMetadata.nowpayments_invoice_id = initialized.invoice_id;
      }

      if (!paymentUrl || !/^https:\/\//i.test(paymentUrl)) {
        throw new BadRequestException(
          'The payment provider did not return a valid checkout URL',
        );
      }

      await this.prisma.transactions.update({
        where: { id: transaction.id },
        data: {
          metadata: {
            ...metadata,
            ...providerMetadata,
          },
        },
      });

      this.logger.log(
        `QR payment initialized ref=${reference} provider=${provider}`,
      );
      return {
        data: {
          reference,
          authorization_url: paymentUrl,
          payment_url: paymentUrl,
          business_name: merchant.business_name,
        },
      };
    } catch (error) {
      await this.markFailed(
        reference,
        'Payment provider initialization failed',
      );
      throw error;
    }
  }

  async verify(reference: string) {
    const transaction = await this.findQrTransaction(reference);
    const metadata =
      (transaction?.metadata as Record<string, unknown> | null) ?? {};
    if (!transaction || !this.isPublicQrSale(transaction, metadata)) {
      throw new NotFoundException('Merchant QR payment was not found');
    }

    const provider = metadata.provider as QrProvider | undefined;
    const canVerify =
      transaction.status === 'pending' ||
      (provider !== 'paystack' && transaction.status === 'failed');
    if (canVerify) {
      const internalReference = transaction.transaction_reference;
      if (provider === 'paystack') {
        const verified =
          await this.paystack.verifyTransaction(internalReference);
        if (verified?.status?.toString().toLowerCase() === 'success') {
          await this.complete(internalReference, 'paystack', verified);
        } else if (
          ['failed', 'abandoned', 'reversed'].includes(
            verified?.status?.toString().toLowerCase() ?? '',
          )
        ) {
          await this.markFailed(
            internalReference,
            'Payment provider reported failure',
          );
        }
      } else if (provider === 'ivorypay') {
        const providerReferences = [
          metadata.provider_ref,
          metadata.provider_reference,
          metadata.provider_transaction_id,
          metadata.provider_checkout_id,
          metadata.provider_payment_id,
          metadata.payment_reference,
          metadata.provider_id,
          metadata.provider_merchant_reference,
          metadata.provider_invoice_id,
          metadata.provider_tx_ref,
          metadata.provider_trxref,
          metadata.provider_transaction_reference,
          reference,
        ]
          .filter(
            (value): value is string =>
              typeof value === 'string' && value.trim().length > 0,
          )
          .map((value) => value.trim());
        const verified = await this.ivorypay.verifyTransaction(
          internalReference,
          String(metadata.provider_ref ?? ''),
          providerReferences,
        );
        const verifiedData = verified?.data ?? verified;
        const status = (verifiedData?.status ?? verified?.status ?? '')
          .toString()
          .toLowerCase();
        if (['success', 'completed'].includes(status ?? '')) {
          await this.complete(internalReference, 'ivorypay', verifiedData);
        } else if (
          ['failed', 'cancelled', 'expired', 'reversed'].includes(status ?? '')
        ) {
          await this.markFailed(
            internalReference,
            'Payment provider reported failure',
          );
        }
      } else if (provider === 'nowpayments') {
        const paymentId = metadata.nowpayments_payment_id?.toString();
        if (paymentId) {
          const verified = await this.nowpayments.getPayment(paymentId);
          const status = verified.payment_status?.toString().toLowerCase();
          if (['finished', 'confirmed'].includes(status ?? '')) {
            await this.complete(internalReference, 'nowpayments', verified);
          } else if (['failed', 'refunded', 'expired'].includes(status ?? '')) {
            await this.markFailed(
              internalReference,
              'NOWPayments reported payment failure',
            );
          }
        }
      }
    }

    const current = await this.prisma.transactions.findUnique({
      where: { transaction_reference: transaction.transaction_reference },
      select: { id: true, status: true },
    });
    const qrPayment = current
      ? await this.prisma.qr_payments.findFirst({
          where: { transaction_id: current.id },
          select: { merchant_id: true },
        })
      : null;
    const merchant = qrPayment?.merchant_id
      ? await this.prisma.merchants.findUnique({
          where: { id: qrPayment.merchant_id },
          select: { business_name: true },
        })
      : null;
    const status = current?.status?.toLowerCase();

    return {
      data: {
        status:
          status === 'completed'
            ? 'completed'
            : ['failed', 'cancelled', 'reversed'].includes(status ?? '')
              ? 'failed'
              : 'pending',
        business_name: merchant?.business_name ?? 'Merchant',
        amount: Number(metadata.amount_fiat ?? 0),
        currency: 'KES',
      },
    };
  }

  async getReceiptDownloadUrl(reference: string) {
    const transaction = await this.findQrTransaction(reference);
    const metadata =
      (transaction?.metadata as Record<string, unknown> | null) ?? {};
    if (
      !transaction ||
      !this.isPublicQrSale(transaction, metadata) ||
      transaction.status?.toLowerCase() !== 'completed'
    ) {
      throw new NotFoundException('Completed QR payment receipt not found');
    }
    return this.receipts.getPublicDownloadUrlForTransaction(transaction.id);
  }

  private findQrTransaction(reference: string) {
    return this.prisma.transactions.findFirst({
      where: {
        AND: [
          {
            OR: [
              { transaction_reference: reference },
              ...[
                'provider_ref',
                'provider_reference',
                'provider_transaction_id',
                'provider_checkout_id',
                'provider_payment_id',
                'payment_reference',
                'provider_id',
                'provider_merchant_reference',
                'provider_invoice_id',
                'provider_tx_ref',
                'provider_trxref',
                'provider_transaction_reference',
              ].map((key) => ({
                metadata: {
                  path: [key],
                  equals: reference,
                },
              })),
            ],
          },
          {
            OR: [
              {
                AND: [
                  { metadata: { path: ['type'], equals: 'qr_sale' } },
                  { metadata: { path: ['isQrSale'], equals: true } },
                ],
              },
              {
                AND: [
                  { transaction_type: 'merchant_payment' },
                  {
                    qr_payments: {
                      some: { merchant_id: { not: null } },
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
      include: { qr_payments: { take: 1 } },
    });
  }

  private isPublicQrSale(
    transaction: {
      transaction_type?: string | null;
      qr_payments?: Array<{ merchant_id: string | null }>;
    },
    metadata: Record<string, unknown>,
  ) {
    return (
      (metadata.type === 'qr_sale' && metadata.isQrSale === true) ||
      (transaction.transaction_type === 'merchant_payment' &&
        transaction.qr_payments?.some((payment) => payment.merchant_id) ===
          true)
    );
  }

  async complete(
    reference: string,
    provider: QrProvider,
    verifiedPayment: Record<string, any>,
  ) {
    const transaction = await this.prisma.transactions.findUnique({
      where: { transaction_reference: reference },
      include: { qr_payments: { take: 1 } },
    });
    const metadata =
      (transaction?.metadata as Record<string, unknown> | null) ?? {};
    if (
      !transaction ||
      !this.isPublicQrSale(transaction, metadata) ||
      metadata.provider !== provider
    ) {
      this.logger.warn(
        `QR settlement ignored ref=${reference} provider=${provider}: payment not found`,
      );
      return false;
    }

    if (provider === 'paystack') {
      const expectedKobo = Math.round(Number(metadata.amount_fiat) * 100);
      if (
        verifiedPayment.status?.toString().toLowerCase() !== 'success' ||
        verifiedPayment.reference !== reference ||
        !Number.isFinite(Number(verifiedPayment.amount)) ||
        Number(verifiedPayment.amount) !== expectedKobo
      ) {
        this.logger.warn(
          `Paystack QR verification did not match ref=${reference}`,
        );
        return false;
      }
    } else if (provider === 'nowpayments') {
      const status = verifiedPayment.payment_status?.toString().toLowerCase();
      const verifiedReference = verifiedPayment.order_id?.toString();
      const verifiedCurrency = verifiedPayment.pay_currency
        ?.toString()
        .toLowerCase();
      const expectedCurrency = (metadata.crypto ?? metadata.pay_currency ?? '')
        .toString()
        .toLowerCase();
      const expectedUsd = Number(metadata.amount_usd);
      const verifiedUsd = Number(verifiedPayment.price_amount);
      if (
        !['finished', 'confirmed'].includes(status ?? '') ||
        verifiedReference !== reference ||
        !/^[a-z0-9]{2,20}$/.test(verifiedCurrency ?? '') ||
        (expectedCurrency.length > 0 &&
          verifiedCurrency !== expectedCurrency) ||
        verifiedPayment.price_currency?.toString().toLowerCase() !== 'usd' ||
        !Number.isFinite(expectedUsd) ||
        !Number.isFinite(verifiedUsd) ||
        Math.abs(expectedUsd - verifiedUsd) > 0.01
      ) {
        this.logger.warn(
          `NOWPayments QR verification did not match ref=${reference}`,
        );
        return false;
      }
    } else {
      const status = verifiedPayment.status?.toString().toLowerCase();
      if (!['success', 'completed'].includes(status ?? '')) {
        this.logger.warn(
          `IvoryPay QR verification did not confirm success ref=${reference}`,
        );
        return false;
      }
      const verifiedReference = verifiedPayment.reference?.toString();
      const verifiedToken = (
        verifiedPayment.token ??
        verifiedPayment.crypto ??
        verifiedPayment.currency ??
        ''
      )
        .toString()
        .toUpperCase();
      const expectedToken = metadata.crypto?.toString().toUpperCase();
      const verifiedExpectedAmount = Number(
        verifiedPayment.expectedAmountInCrypto ??
          verifiedPayment.amount_usd ??
          verifiedPayment.amount ??
          NaN,
      );
      const expectedCryptoAmount = Number(metadata.amount_usd);
      if (
        verifiedReference !== reference ||
        !expectedToken ||
        verifiedToken !== expectedToken ||
        !Number.isFinite(verifiedExpectedAmount) ||
        !Number.isFinite(expectedCryptoAmount) ||
        verifiedExpectedAmount <= 0 ||
        expectedCryptoAmount <= 0 ||
        Math.abs(verifiedExpectedAmount - expectedCryptoAmount) > 1e-8
      ) {
        this.logger.warn(
          `IvoryPay QR verification did not match ref=${reference} expectedToken=${expectedToken ?? 'missing'} receivedToken=${verifiedToken || 'missing'} expectedCrypto=${expectedCryptoAmount} verifiedCrypto=${verifiedExpectedAmount}`,
        );
        return false;
      }
    }

    const qrPayment = transaction.qr_payments[0];
    if (!qrPayment?.merchant_id || !transaction.receiver_wallet_id) {
      this.logger.error(
        `QR payment is missing its merchant or wallet ref=${reference}`,
      );
      return false;
    }
    const merchantId = qrPayment.merchant_id;
    const walletId = transaction.receiver_wallet_id;

    const merchantRule = await ruleFor(this.fees, 'merchant');
    const settled = await this.prisma.$transaction(async (tx) => {
      const settledAt = new Date();
      const amount = Number(transaction.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new BadRequestException('QR payment amount is invalid');
      }
      const saleFee = computeFee(merchantRule, amount, 8);
      const merchantNet = amount - saleFee;
      const claim = await tx.transactions.updateMany({
        where: { id: transaction.id, status: { in: ['pending', 'failed'] } },
        data: {
          status: 'completed',
          processed_at: settledAt,
          fee: saleFee,
          net_amount: merchantNet,
          description: 'Public QR merchant payment',
        },
      });
      if (claim.count !== 1) return null;

      const wallet = await tx.wallets.findUnique({
        where: { id: walletId },
        select: { id: true, user_id: true, balance: true, wallet_type: true },
      });
      // Business wallets have no user_id; notify the merchant owner instead.
      const ownerId =
        wallet?.user_id ??
        (wallet?.wallet_type === 'merchant'
          ? (
              await tx.merchants.findUnique({
                where: { id: merchantId },
                select: { user_id: true },
              })
            )?.user_id
          : null);
      if (!wallet || !ownerId) {
        throw new BadRequestException('Merchant wallet is unavailable');
      }
      const balanceBefore = Number(wallet.balance ?? 0);
      const updatedWallet = await tx.wallets.update({
        where: { id: wallet.id },
        data: { balance: { increment: merchantNet } },
        select: { balance: true },
      });
      await tx.ledger_entries.create({
        data: {
          transaction_id: transaction.id,
          wallet_id: wallet.id,
          entry_type: 'credit',
          amount: merchantNet,
          balance_before: balanceBefore,
          balance_after: Number(updatedWallet.balance),
          description: 'Public QR payment after 1% platform sales fee',
        },
      });
      const superadmin = await tx.users.findFirst({
        where: { role: 'super_admin', is_deleted: false },
        include: { wallets: { where: { is_active: true }, take: 1 } },
      });
      const superadminWallet = superadmin?.wallets[0];
      if (!superadmin || !superadminWallet) {
        throw new NotFoundException('Superadmin wallet not found');
      }
      const superadminBalanceBefore = Number(superadminWallet.balance ?? 0);
      const updatedSuperadminWallet = await tx.wallets.update({
        where: { id: superadminWallet.id },
        data: { balance: { increment: saleFee } },
        select: { balance: true },
      });
      await tx.ledger_entries.create({
        data: {
          transaction_id: transaction.id,
          wallet_id: superadminWallet.id,
          entry_type: 'credit',
          amount: saleFee,
          balance_before: superadminBalanceBefore,
          balance_after: Number(updatedSuperadminWallet.balance),
          description: '1% platform fee from public QR merchant sale',
        },
      });
      const completedPayment = await tx.qr_payments.updateMany({
        where: {
          transaction_id: transaction.id,
          merchant_id: merchantId,
          status: { in: ['pending', 'failed'] },
        },
        data: { status: 'completed' },
      });
      if (completedPayment.count !== 1) {
        throw new BadRequestException(
          'QR payment state changed during settlement',
        );
      }
      await tx.merchants.update({
        where: { id: merchantId },
        data: { total_sales: { increment: amount } },
      });
      const receipt = await this.receipts.createForTransaction(
        tx,
        transaction.id,
        merchantId,
        transaction.amount,
        settledAt,
        saleFee,
      );
      return {
        userId: ownerId,
        balance: Number(updatedWallet.balance),
        amount,
        saleFee,
        merchantNet,
        merchantId,
        superadminId: superadmin.id,
        superadminBalance: Number(updatedSuperadminWallet.balance),
        receiptId: receipt.id,
      };
    });

    if (!settled) {
      this.logger.log(
        `QR payment already finalized or no longer pending ref=${reference}`,
      );
      return false;
    }

    this.receipts.enqueuePdfAndEmail(settled.receiptId);

    try {
      this.websocket.emitBalanceUpdate(settled.userId, settled.balance);
      this.websocket.emitTransactionUpdate(settled.userId, {
        reference,
        status: 'SUCCESS',
      });
      this.websocket.emitBalanceUpdate(
        settled.superadminId,
        settled.superadminBalance,
      );
      this.websocket.emitTransactionUpdate(settled.superadminId, {
        reference,
        status: 'SUCCESS',
      });
    } catch (error) {
      this.logger.error(
        `QR payment realtime update failed ref=${reference}`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    const cacheInvalidation = this.cache
      .invalidateWallet(settled.userId)
      .catch((error) => {
        this.logger.error(
          `QR payment wallet cache invalidation failed ref=${reference}`,
          error instanceof Error ? error.stack : String(error),
        );
      });
    const transactionHistoryCacheInvalidation = this.cache
      .cacheInvalidatePattern(`transactions:${settled.userId}:*`)
      .catch((error) => {
        this.logger.error(
          `QR payment transaction history cache invalidation failed ref=${reference}`,
          error instanceof Error ? error.stack : String(error),
        );
      });
    const superadminCacheInvalidation = Promise.all([
      this.cache.invalidateWallet(settled.superadminId),
      this.cache.cacheDelete('admin:superadmin-dashboard'),
    ]).catch((error) => {
      this.logger.error(
        `QR payment superadmin cache invalidation failed ref=${reference}`,
        error instanceof Error ? error.stack : String(error),
      );
    });
    const notificationDelivery = this.notifications
      .sendNotification(settled.userId, {
        type: 'merchant',
        entityId: reference,
        title: 'Merchant payment successful',
        body: `Your business received ${settled.merchantNet} FARM after the 1% sales fee from a QR payment.`,
        metadata: {
          event: 'merchant_payment_received',
          merchant_id: settled.merchantId,
          amount: settled.amount,
          fee: settled.saleFee,
          net_amount: settled.merchantNet,
          currency: 'FARM',
          reference,
        },
      })
      .catch((error) => {
        this.logger.error(
          `Could not notify merchant owner about QR payment ${reference}`,
          error instanceof Error ? error.stack : String(error),
        );
      });
    await Promise.all([
      cacheInvalidation,
      transactionHistoryCacheInvalidation,
      superadminCacheInvalidation,
      notificationDelivery,
    ]);

    this.logger.log(
      `QR payment credited ref=${reference} merchant=${settled.merchantId}`,
    );
    return true;
  }

  async markFailed(reference: string, reason: string) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.transactions.findUnique({
        where: { transaction_reference: reference },
        select: { id: true },
      });
      if (!existing) return false;
      const transaction = await tx.transactions.updateMany({
        where: {
          id: existing.id,
          status: 'pending',
        },
        data: { status: 'failed', processed_at: new Date() },
      });
      if (transaction.count !== 1) return false;
      await tx.qr_payments.updateMany({
        where: { transaction_id: existing.id, status: 'pending' },
        data: { status: 'failed' },
      });
      return true;
    });
    if (updated) {
      this.logger.warn(`QR payment failed ref=${reference}: ${reason}`);
    }
    return updated;
  }
}
