import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { FeesService } from '../fees/fees.service';
import { feeFor } from '../fees/fee-defaults';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import * as QRCode from 'qrcode';
import { CacheService } from '../common/cache/cache.service';
import { PrismaService } from '../database/prisma.service';
import { AuthService } from '../auth/auth.service';
import { SecurityService } from '../security/security.service';
import { NotificationsService } from '../notifications/notifications.service';
import { generateTxReference } from '../common/utils/reference.util';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import {
  MERCHANT_CHECKOUT_URL,
  PUBLIC_CHECKOUT_BASE_URL,
} from './merchant-checkout.constants';

import { settlementWalletFor } from '../business-ops/business-wallet';

@Injectable()
export class QrService {
  private readonly logger = new Logger(QrService.name);

  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
    private securityService: SecurityService,
    private cfg: ConfigService,
    private notificationsService: NotificationsService,
    private websocket: WebsocketGateway,
    @Optional() private readonly cache?: CacheService,
    @Optional() private readonly fees?: FeesService,
  ) {}

  async generateMerchantQr(merchantId: string) {
    const merchant = await this.prisma.merchants.findUnique({
      where: { id: merchantId },
    });
    if (!merchant) throw new NotFoundException('Merchant not found');
    const payload = {
      merchant_id: merchantId,
      business_name: merchant.business_name,
      v: 1,
    };
    const payloadStr = JSON.stringify(payload);
    const sig = this.sign(
      payloadStr,
      merchant.qr_secret || this.cfg.get('QR_HMAC_SECRET', ''),
    );
    const signed = JSON.stringify({ ...payload, sig });
    const checkoutUrl = this.checkoutUrl(signed);
    const qr_image = await QRCode.toDataURL(checkoutUrl);
    await this.prisma.merchants.update({
      where: { id: merchantId },
      data: { qr_code: signed },
    });
    return {
      data: {
        qr_payload: signed,
        checkout_url: checkoutUrl,
        qr_image_base64: qr_image,
        qr_image_data_url: qr_image,
      },
    };
  }

  async getMerchantQr(merchantId: string) {
    const merchant = await this.prisma.merchants.findUnique({
      where: { id: merchantId },
    });
    if (!merchant) throw new NotFoundException('Merchant not found');
    if (!merchant.qr_code) {
      return this.generateMerchantQr(merchantId);
    }
    const checkoutUrl = this.checkoutUrl(merchant.qr_code);
    const qr_image = await QRCode.toDataURL(checkoutUrl);
    return {
      data: {
        qr_payload: merchant.qr_code,
        checkout_url: checkoutUrl,
        qr_image_base64: qr_image,
        qr_image_data_url: qr_image,
      },
    };
  }

  async generateReceiveQr(userId: string, amount?: number) {
    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: userId, is_active: true },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
    const payload = JSON.stringify({
      wallet_address: wallet.wallet_address,
      amount: amount || null,
      v: 1,
    });
    const qr_image = await QRCode.toDataURL(payload);
    return { data: { qr_payload: payload, qr_image_base64: qr_image } };
  }

  private unwrapQrPayload(scannedPayload: string): string {
    let payload = scannedPayload.trim();
    for (let depth = 0; depth < 3; depth += 1) {
      try {
        JSON.parse(payload);
        return payload;
      } catch {
        // Continue only when the scanned text contains an encoded QR payload.
      }

      let qrValue: string | null = null;
      try {
        qrValue = new URL(payload).searchParams.get('qr');
      } catch {
        // Not a URL; peer identifiers are handled by validate().
      }
      if (!qrValue) return payload;

      let decoded = qrValue;
      try {
        const base64Decoded = Buffer.from(qrValue, 'base64url').toString(
          'utf8',
        );
        if (base64Decoded.trimStart().startsWith('{')) {
          decoded = base64Decoded;
        } else {
          try {
            decoded = decodeURIComponent(qrValue);
          } catch {
            return payload;
          }
        }
      } catch {
        return payload;
      }
      if (decoded === payload) return payload;
      payload = decoded.trim();
    }
    return payload;
  }

  async validate(scannedPayload: string, customerId: string) {
    let parsed: any;
    const normalizedPayload = this.unwrapQrPayload(scannedPayload);

    try {
      const url = new URL(normalizedPayload);
      const directPayPath = url.pathname.match(/\/pay\/([^/]+)\/?$/);
      if (directPayPath) {
        const merchant = await this.prisma.merchants.findUnique({
          where: { id: decodeURIComponent(directPayPath[1]) },
        });
        if (!merchant || merchant.status !== 'approved') {
          throw new BadRequestException(
            'Merchant is not approved to accept payments',
          );
        }
        return {
          data: {
            valid: true,
            type: 'merchant',
            merchant_id: merchant.id,
            business_name: merchant.business_name,
            fee_percent: Number(merchant.transaction_fee_percent || 0),
            daily_limit: Number(merchant.daily_limit || 0),
          },
        };
      }
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      // Non-URL payloads continue through the existing signed QR validation.
    }

    try {
      parsed = JSON.parse(normalizedPayload);
    } catch {
      const identifier = normalizedPayload;
      if (!identifier) throw new BadRequestException('Invalid QR payload');

      const normalizedUsername = identifier.startsWith('@')
        ? identifier.substring(1).trim().toLowerCase()
        : identifier.toLowerCase();

      const user = await this.prisma.users.findFirst({
        where: {
          OR: [{ username: normalizedUsername }, { phone: identifier }],
        },
        include: {
          wallets: {
            where: { is_active: true },
            take: 1,
          },
        },
      });

      if (!user || !user.wallets?.length) {
        throw new BadRequestException('User not found or wallet unavailable');
      }

      return {
        data: {
          valid: true,
          type: 'peer',
          wallet_address: user.wallets[0].wallet_address,
          suggested_amount: null,
        },
      };
    }

    if (parsed.merchant_id) {
      const merchant = await this.prisma.merchants.findUnique({
        where: { id: parsed.merchant_id },
      });
      if (!merchant) {
        throw new BadRequestException('Merchant not found');
      }
      if (merchant.status !== 'approved') {
        throw new ForbiddenException(
          'Merchant is not approved to accept payments',
        );
      }

      const { sig, ...data } = parsed;
      const expected = this.sign(
        JSON.stringify(data),
        merchant.qr_secret || this.cfg.get('QR_HMAC_SECRET', ''),
      );
      if (sig !== expected)
        throw new BadRequestException('QR signature invalid');

      return {
        data: {
          valid: true,
          type: 'merchant',
          merchant_id: merchant.id,
          business_name:
            merchant.business_name || parsed.business_name || 'Merchant',
          fee_percent: Number(merchant.transaction_fee_percent || 0),
          daily_limit: Number(merchant.daily_limit || 0),
        },
      };
    }

    if (parsed.wallet_address) {
      const wallet = await this.prisma.wallets.findUnique({
        where: { wallet_address: parsed.wallet_address },
      });
      if (!wallet) throw new BadRequestException('Invalid wallet address');
      return {
        data: {
          valid: true,
          type: 'peer',
          wallet_address: parsed.wallet_address,
          suggested_amount: parsed.amount,
        },
      };
    }

    throw new BadRequestException('Unknown QR type');
  }

  async merchantPay(
    customerId: string,
    dto: {
      qr_payload: string;
      amount: number;
      pin?: string;
      biometric_auth?: boolean;
      device_fingerprint?: string;
    },
  ) {
    if (dto.amount <= 0)
      throw new BadRequestException('Amount must be positive');
    if (dto.biometric_auth) {
      const deviceFingerprint =
        dto.device_fingerprint || (dto as any).deviceFingerprint;
      if (!deviceFingerprint)
        throw new BadRequestException(
          'Device fingerprint required for biometric authorization',
        );
      const verified = await this.securityService.verifyDevice(
        customerId,
        deviceFingerprint,
      );
      if (!verified || (verified as any).trusted !== true) {
        throw new BadRequestException('Biometric device verification failed');
      }
    } else {
      if (!dto.pin) throw new BadRequestException('Transaction PIN required');
      await this.authService.verifyPin(customerId, dto.pin);
    }

    const validation = (await this.validate(dto.qr_payload, customerId)).data;
    if (!validation.valid || validation.type !== 'merchant')
      throw new BadRequestException('Invalid merchant QR');

    const merchant = await this.prisma.merchants.findUnique({
      where: { id: (validation as any).merchant_id },
    });
    if (!merchant) throw new NotFoundException('Merchant not found');
    if (merchant.status !== 'approved') {
      throw new ForbiddenException(
        'Merchant is not approved to accept payments',
      );
    }

    if (!merchant.user_id || merchant.user_id === customerId) {
      throw new BadRequestException('You cannot pay your own merchant account');
    }

    const customerWallet = await this.prisma.wallets.findFirst({
      where: { user_id: customerId, wallet_type: 'user', is_active: true },
    });
    // BUSINESS_WALLET_ENABLED: settle into the business wallet (legacy: owner's personal wallet).
    const merchantWallet = await settlementWalletFor(this.prisma, {
      merchantId: merchant.id,
      ownerUserId: merchant.user_id,
    });
    if (!customerWallet || !merchantWallet)
      throw new NotFoundException('Wallet not found');

    const customerFee =
      dto.amount * (Number(merchant.transaction_fee_percent || 0) / 100);
    const saleFee = await feeFor(this.fees, 'merchant', dto.amount, 8);
    const merchantNet = dto.amount - saleFee;
    const totalOut = dto.amount + customerFee;
    const available =
      Number(customerWallet.balance) - Number(customerWallet.locked_balance);
    if (available < totalOut)
      throw new BadRequestException(
        `Insufficient balance. Available: ${available.toFixed(2)} FARM`,
      );

    const result = await this.prisma.$transaction(async (tx) => {
      const reference = generateTxReference();
      const txn = await tx.transactions.create({
        data: {
          transaction_reference: reference,
          sender_wallet_id: customerWallet.id,
          receiver_wallet_id: merchantWallet.id,
          transaction_type: 'merchant_payment',
          status: 'completed',
          amount: dto.amount,
          fee: saleFee,
          net_amount: merchantNet,
          currency: 'FARM',
          description: `Payment to ${merchant.business_name}`,
          metadata: {
            user_id: customerId,
            merchant_id: merchant.id,
            platform_fee_type: 'merchant_sale',
            platform_fee_percent: 1,
            platform_fee: saleFee,
            customer_fee: customerFee,
          },
          processed_at: new Date(),
        },
      });
      const updatedCustomerWallet = await tx.wallets.update({
        where: { id: customerWallet.id },
        data: { balance: { decrement: totalOut } },
      });
      const updatedMerchantWallet = await tx.wallets.update({
        where: { id: merchantWallet.id },
        data: { balance: { increment: merchantNet } },
      });
      const superadmin = await tx.users.findFirst({
        where: { role: 'super_admin', is_deleted: false },
        include: { wallets: { where: { is_active: true }, take: 1 } },
      });
      const superadminWallet = superadmin?.wallets[0];
      if (!superadmin || !superadminWallet) {
        throw new NotFoundException('Superadmin wallet not found');
      }
      const updatedSuperadminWallet = await tx.wallets.update({
        where: { id: superadminWallet.id },
        data: { balance: { increment: saleFee } },
      });

      // Preserve the existing customer-paid merchant surcharge separately.
      const platformWallet = await tx.wallets.findFirst({
        where: {
          OR: [
            { wallet_type: 'platform', is_active: true },
            { user_id: null, is_active: true },
          ],
        },
      });
      if (platformWallet) {
        await tx.wallets.update({
          where: { id: platformWallet.id },
          data: { balance: { increment: customerFee } },
        });
      }
      await tx.merchants.update({
        where: { id: merchant.id },
        data: { total_sales: { increment: dto.amount } },
      });
      await tx.qr_payments.create({
        data: {
          merchant_id: merchant.id,
          customer_id: customerId,
          transaction_id: txn.id,
          qr_payload: dto.qr_payload,
          amount: dto.amount,
          status: 'completed',
          scanned_at: new Date(),
        },
      });
      await tx.ledger_entries.createMany({
        data: [
          {
            transaction_id: txn.id,
            wallet_id: customerWallet.id,
            entry_type: 'debit',
            amount: totalOut,
            description: `QR payment to ${merchant.business_name}`,
          },
          {
            transaction_id: txn.id,
            wallet_id: merchantWallet.id,
            entry_type: 'credit',
            amount: merchantNet,
            description: 'QR payment received after 1% platform sales fee',
          },
          {
            transaction_id: txn.id,
            wallet_id: superadminWallet.id,
            entry_type: 'credit',
            amount: saleFee,
            description: '1% platform fee from merchant QR sale',
          },
          ...(platformWallet
            ? [
                {
                  transaction_id: txn.id,
                  wallet_id: platformWallet.id,
                  entry_type: 'credit',
                  amount: customerFee,
                  description: 'Customer-paid merchant QR surcharge',
                },
              ]
            : []),
        ],
      });
      return {
        transaction: txn,
        customerBalance: Number(updatedCustomerWallet.balance),
        merchantBalance: Number(updatedMerchantWallet.balance),
        superadminId: superadmin.id,
        superadminBalance: Number(updatedSuperadminWallet.balance),
        merchantNet,
        saleFee,
      };
    });

    try {
      this.websocket.emitBalanceUpdate(customerId, result.customerBalance);
      this.websocket.emitTransactionUpdate(customerId, {
        reference: result.transaction.transaction_reference,
        status: 'SUCCESS',
      });
      if (merchant.user_id) {
        this.websocket.emitBalanceUpdate(
          merchant.user_id,
          result.merchantBalance,
        );
        this.websocket.emitTransactionUpdate(merchant.user_id, {
          reference: result.transaction.transaction_reference,
          status: 'SUCCESS',
        });
      }
      this.websocket.emitBalanceUpdate(
        result.superadminId,
        result.superadminBalance,
      );
      this.websocket.emitTransactionUpdate(result.superadminId, {
        reference: result.transaction.transaction_reference,
        status: 'SUCCESS',
      });
    } catch (error) {
      this.logger.warn(
        `Merchant payment realtime update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const customer = await this.prisma.users.findUnique({
      where: { id: customerId },
      select: { username: true },
    });
    const payerName =
      customer?.username != null ? `@${customer.username}` : 'A customer';

    if (this.cache) {
      try {
        await Promise.all([
          this.cache.invalidateWallet(customerId),
          this.cache.invalidateWallet(merchant.user_id),
          this.cache.invalidateWallet(result.superadminId),
          this.cache.cacheDelete('admin:superadmin-dashboard'),
        ]);
      } catch (error) {
        this.logger.error(
          `Merchant payment cache invalidation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await Promise.all([
      this.notificationsService.sendNotification(customerId, {
        type: 'merchant',
        entityId: result.transaction.transaction_reference,
        title: 'Merchant payment sent',
        body: `You sent ${dto.amount} FARM to ${merchant.business_name}.`,
        metadata: {
          merchant_id: merchant.id,
          merchant_name: merchant.business_name,
          amount: dto.amount,
          event: 'merchant_payment_sent',
        },
      }),
      merchant.user_id
        ? this.notificationsService.sendNotification(merchant.user_id, {
            type: 'merchant',
            entityId: result.transaction.transaction_reference,
            title: 'Merchant payment received',
            body: `You received ${result.merchantNet} FARM after the 1% sales fee from ${payerName}.`,
            metadata: {
              merchant_id: merchant.id,
              customer_id: customerId,
              customer_username: customer?.username,
              amount: dto.amount,
              fee: result.saleFee,
              net_amount: result.merchantNet,
              event: 'merchant_payment_received',
            },
          })
        : Promise.resolve(null),
    ]).catch((error) =>
      this.logger.error('Merchant payment notification failed', error),
    );

    return {
      data: {
        reference: result.transaction.transaction_reference,
        amount: dto.amount,
        fee: customerFee,
        platform_fee: result.saleFee,
        merchant_net: result.merchantNet,
        status: 'completed',
      },
      message: `Payment to ${merchant.business_name} successful`,
    };
  }

  private sign(data: string, secret: string) {
    return createHmac('sha256', secret || 'fallback')
      .update(data)
      .digest('hex');
  }

  private checkoutUrl(signedPayload: string) {
    try {
      const payload = JSON.parse(signedPayload) as { merchant_id?: string };
      if (payload.merchant_id) {
        const merchantId = payload.merchant_id.replace(/[{}]/g, '').trim();
        if (merchantId) {
          return `${PUBLIC_CHECKOUT_BASE_URL}/checkout/${encodeURIComponent(merchantId)}`;
        }
      }
    } catch {
      // Older non-JSON QR payloads remain available through the legacy checkout.
    }
    const encodedPayload = Buffer.from(signedPayload, 'utf8').toString(
      'base64url',
    );
    return `${MERCHANT_CHECKOUT_URL}?qr=${encodedPayload}`;
  }
}
