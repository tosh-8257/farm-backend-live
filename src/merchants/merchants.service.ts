import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { QrService } from '../qr/qr.service';
import { CacheService } from '../common/cache/cache.service';
import { paginationParams, paginate } from '../common/utils/pagination.util';
import { randomBytes } from 'crypto';

import {
  businessWalletEnabled,
  settlementWalletFor,
} from '../business-ops/business-wallet';

@Injectable()
export class MerchantsService {
  constructor(
    private prisma: PrismaService,
    private qrService: QrService,
    private cache: CacheService,
  ) {}

  async apply(
    userId: string,
    dto: {
      business_name: string;
      business_type?: string;
      business_email?: string;
      business_phone?: string;
      country?: string;
      city?: string;
    },
  ) {
    const existing = await this.prisma.merchants.findFirst({
      where: { user_id: userId },
    });
    if (existing) {
      if (existing.status !== 'rejected') {
        throw new BadRequestException(
          'You already have a merchant application',
        );
      }

      const merchant = await this.prisma.merchants.update({
        where: { id: existing.id },
        data: {
          ...dto,
          status: 'pending',
          approved_by: null,
          approved_at: null,
        },
      });
      await this.invalidateMerchantCaches(userId);
      return {
        data: merchant,
        message: 'Application resubmitted. Pending review.',
      };
    }

    const merchant = await this.prisma.merchants.create({
      data: {
        user_id: userId,
        ...dto,
        qr_secret: randomBytes(32).toString('hex'),
        status: 'pending',
      },
    });
    await this.invalidateMerchantCaches(userId);
    return {
      data: merchant,
      message: 'Application submitted. Pending review.',
    };
  }

  async getDashboard(userId: string) {
    const merchant = await this.prisma.merchants.findFirst({
      where: { user_id: userId },
    });
    if (!merchant) {
      return {
        data: {
          application_status: 'not_submitted',
          message:
            'Welcome to the Merchant Portal. Submit your business details to get started.',
        },
      };
    }

    if (merchant.status !== 'approved') {
      return {
        data: {
          application_status: merchant.status ?? 'pending',
          merchant,
          message:
            merchant.status === 'rejected'
              ? 'Your merchant application was not approved. Please review your details and submit again.'
              : 'Your merchant details are being reviewed. Please wait for an admin decision.',
        },
      };
    }

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { kyc_status: true, kyc_level: true },
    });
    if (
      !user ||
      user.kyc_status !== 'verified' ||
      Number(user.kyc_level || 0) < 3
    ) {
      throw new ForbiddenException(
        'Full KYC verification is required to access the merchant dashboard',
      );
    }

    const cacheKey = `merchant-dashboard:${userId}`;
    const cached = await this.cache.cacheGet<any>(cacheKey);
    if (cached) return cached;

    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: userId, is_active: true, wallet_type: 'user' },
    });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const qrData = await this.qrService.getMerchantQr(merchant.id);

    const currentMonthStart = new Date(
      today.getFullYear(),
      today.getMonth(),
      1,
    );
    const nextMonthStart = new Date(
      today.getFullYear(),
      today.getMonth() + 1,
      1,
    );
    const previousMonthStart = new Date(
      today.getFullYear(),
      today.getMonth() - 1,
      1,
    );

    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - 6);

    const [
      salesToday,
      totalRevenue,
      currentMonthRevenue,
      previousMonthRevenue,
      weeklySales,
      recentTxns,
    ] = await Promise.all([
      this.prisma.transactions.aggregate({
        where: {
          receiver_wallet_id: wallet?.id,
          transaction_type: 'merchant_payment',
          status: 'completed',
          created_at: { gte: today },
        },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.transactions.aggregate({
        where: {
          receiver_wallet_id: wallet?.id,
          transaction_type: 'merchant_payment',
          status: 'completed',
        },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.transactions.aggregate({
        where: {
          receiver_wallet_id: wallet?.id,
          transaction_type: 'merchant_payment',
          status: 'completed',
          created_at: { gte: currentMonthStart, lt: nextMonthStart },
        },
        _sum: { amount: true },
      }),
      this.prisma.transactions.aggregate({
        where: {
          receiver_wallet_id: wallet?.id,
          transaction_type: 'merchant_payment',
          status: 'completed',
          created_at: { gte: previousMonthStart, lt: currentMonthStart },
        },
        _sum: { amount: true },
      }),
      this.prisma.transactions.findMany({
        where: {
          receiver_wallet_id: wallet?.id,
          transaction_type: 'merchant_payment',
          status: 'completed',
          created_at: { gte: weekStart },
        },
        select: { amount: true, created_at: true },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.transactions.findMany({
        where: {
          receiver_wallet_id: wallet?.id,
          transaction_type: 'merchant_payment',
        },
        orderBy: { created_at: 'desc' },
        take: 10,
      }),
    ]);

    const currentMonthRevenueValue = Number(
      currentMonthRevenue._sum.amount || 0,
    );
    const previousMonthRevenueValue = Number(
      previousMonthRevenue._sum.amount || 0,
    );
    const monthlyGrowth =
      previousMonthRevenueValue === 0
        ? currentMonthRevenueValue === 0
          ? 0
          : 100
        : Number(
            (
              ((currentMonthRevenueValue - previousMonthRevenueValue) /
                previousMonthRevenueValue) *
              100
            ).toFixed(2),
          );

    const weeklyPerformance = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(weekStart);
      date.setDate(weekStart.getDate() + index);
      return {
        date: date.toISOString().slice(0, 10),
        amount: 0,
        count: 0,
      };
    });
    for (const sale of weeklySales) {
      const saleDate = sale.created_at;
      if (!saleDate) continue;
      const dayIndex = Math.floor(
        (new Date(saleDate).getTime() - weekStart.getTime()) / 86400000,
      );
      if (dayIndex >= 0 && dayIndex < weeklyPerformance.length) {
        weeklyPerformance[dayIndex].amount += Number(sale.amount ?? 0);
        weeklyPerformance[dayIndex].count += 1;
      }
    }

    // Enrich recent transactions with customer username where possible
    const enrichedRecent = await Promise.all(
      recentTxns.map(async (t: any) => {
        const txn: any = { ...t };
        txn.amount = Number(txn.amount || 0);

        // Try to find a direct customer_id on the transaction or in metadata
        let customerId: string | undefined;
        if (txn.customer_id) customerId = txn.customer_id;
        if (!customerId && txn.metadata && typeof txn.metadata === 'object') {
          customerId = txn.metadata.user_id || txn.metadata.customer_id;
        }

        let customerName = '@user';
        let merchantBusinessName = '';

        if (customerId) {
          const u = await this.prisma.users.findUnique({
            where: { id: customerId },
          });
          if (u && u.username) customerName = `@${u.username}`;
        } else if (txn.sender_wallet_id) {
          // Fallback: fetch sender wallet and its user
          const senderWallet = await this.prisma.wallets.findUnique({
            where: { id: txn.sender_wallet_id },
            include: { users: true },
          });
          const u = senderWallet?.users as any;
          if (u && u.username) customerName = `@${u.username}`;
        }

        if (txn.metadata && typeof txn.metadata === 'object') {
          const merchantId =
            txn.metadata.merchant_id || txn.metadata.merchantId;
          if (merchantId) {
            const merchant = await this.prisma.merchants.findUnique({
              where: { id: merchantId },
              select: { business_name: true },
            });
            if (merchant?.business_name)
              merchantBusinessName = merchant.business_name;
          }
        }

        txn.customer_name = customerName;
        txn.merchant_business_name = merchantBusinessName;
        if (typeof txn.metadata?.guest_email === 'string') {
          txn.payer_email = txn.metadata.guest_email;
        }
        return txn;
      }),
    );

    const payload = {
      data: {
        merchant: {
          id: merchant.id,
          business_name: merchant.business_name,
          status: merchant.status,
          qr_code: merchant.qr_code,
          qr_payload: qrData?.data?.qr_payload ?? merchant.qr_code,
          qr_image_base64: qrData?.data?.qr_image_base64,
          qr_image_data_url:
            qrData?.data?.qr_image_data_url ?? qrData?.data?.qr_image_base64,
          qrImageBase64: qrData?.data?.qr_image_base64,
          qrImageDataUrl:
            qrData?.data?.qr_image_data_url ?? qrData?.data?.qr_image_base64,
        },
        stats: {
          sales_today: Number(salesToday._sum.amount || 0),
          sales_today_count: salesToday._count,
          total_revenue: Number(totalRevenue._sum.amount || 0),
          total_transactions: totalRevenue._count,
          wallet_balance: Number(wallet?.balance || 0),
          current_month_revenue: currentMonthRevenueValue,
          previous_month_revenue: previousMonthRevenueValue,
          monthly_growth_percentage: monthlyGrowth,
          weekly_performance: weeklyPerformance,
        },
        recent_transactions: enrichedRecent,
      },
    };

    await this.cache.cacheSet(cacheKey, payload, 60);
    return payload;
  }

  async getMyMerchant(userId: string) {
    const cacheKey = `merchant-profile:${userId}`;
    const cached = await this.cache.cacheGet<any>(cacheKey);
    if (cached) return cached;

    const payload = { data: await this.getMerchantByUser(userId) };
    await this.cache.cacheSet(cacheKey, payload, 60);
    return payload;
  }

  async getTransactions(userId: string, query: any) {
    const merchant = await this.getMerchantByUser(userId);
    if (merchant.status !== 'approved') {
      throw new ForbiddenException('Merchant application is pending approval');
    }
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const cacheKey = `merchant-transactions:${userId}:${page}:${limit}`;
    const cached = await this.cache.cacheGet<any>(cacheKey);
    if (cached) return cached;

    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: userId },
    });
    const [items, total] = await Promise.all([
      this.prisma.transactions.findMany({
        where: {
          receiver_wallet_id: wallet?.id,
          transaction_type: 'merchant_payment',
        },
        skip,
        take,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.transactions.count({
        where: {
          receiver_wallet_id: wallet?.id,
          transaction_type: 'merchant_payment',
        },
      }),
    ]);
    const payload = {
      data: items.map((t) => {
        const metadata =
          t.metadata && typeof t.metadata === 'object'
            ? (t.metadata as Record<string, unknown>)
            : {};
        const payerEmail =
          typeof metadata.guest_email === 'string'
            ? metadata.guest_email
            : typeof metadata.customer_email === 'string'
              ? metadata.customer_email
              : null;
        return {
          ...t,
          amount: Number(t.amount),
          payer_email: payerEmail,
        };
      }),
      meta: paginate(total, page, limit),
    };

    await this.cache.cacheSet(cacheKey, payload, 45);
    return payload;
  }

  async requestPayout(
    userId: string,
    dto: {
      amount: number;
      payout_method: string;
      account_name: string;
      account_number: string;
    },
  ) {
    const merchant = await this.getMerchantByUser(userId);
    if (merchant.status !== 'approved')
      throw new ForbiddenException('Merchant not approved');
    // BUSINESS_WALLET_ENABLED: the business wallet funds merchant payouts.
    const wallet = businessWalletEnabled()
      ? await settlementWalletFor(this.prisma, {
          merchantId: merchant.id,
          ownerUserId: userId,
        })
      : await this.prisma.wallets.findFirst({
          where: { user_id: userId },
        });
    const available =
      Number(wallet?.balance || 0) - Number(wallet?.locked_balance || 0);
    if (available < dto.amount)
      throw new BadRequestException('Insufficient balance');
    const payout = await this.prisma.merchant_payouts.create({
      data: {
        merchant_id: merchant.id,
        amount: dto.amount,
        payout_method: dto.payout_method,
        account_name: dto.account_name,
        account_number: dto.account_number,
        status: 'pending',
      },
    });
    await this.invalidateMerchantCaches(userId);
    return { data: payout, message: 'Payout request submitted' };
  }

  async getPayouts(userId: string, query: any) {
    const merchant = await this.getMerchantByUser(userId);
    if (merchant.status !== 'approved') {
      throw new ForbiddenException('Merchant application is pending approval');
    }
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const cacheKey = `merchant-payouts:${userId}:${page}:${limit}`;
    const cached = await this.cache.cacheGet<any>(cacheKey);
    if (cached) return cached;

    const [items, total] = await Promise.all([
      this.prisma.merchant_payouts.findMany({
        where: { merchant_id: merchant.id },
        skip,
        take,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.merchant_payouts.count({
        where: { merchant_id: merchant.id },
      }),
    ]);
    const payload = {
      data: items.map((p) => ({ ...p, amount: Number(p.amount) })),
      meta: paginate(total, page, limit),
    };

    await this.cache.cacheSet(cacheKey, payload, 45);
    return payload;
  }

  async regenerateQr(userId: string) {
    const merchant = await this.getMerchantByUser(userId);
    if (merchant.status !== 'approved') {
      throw new ForbiddenException('Merchant application is pending approval');
    }
    const result = await this.qrService.generateMerchantQr(merchant.id);
    await this.invalidateMerchantCaches(userId);
    return result;
  }

  async getMerchantQr(userId: string) {
    const merchant = await this.getMerchantByUser(userId);
    if (merchant.status !== 'approved') {
      throw new ForbiddenException('Merchant application is pending approval');
    }
    const cacheKey = `merchant-qr:${userId}`;
    const cached = await this.cache.cacheGet<any>(cacheKey);
    if (cached) return cached;

    const result = !merchant.qr_code
      ? await this.qrService.generateMerchantQr(merchant.id)
      : await this.qrService.getMerchantQr(merchant.id);

    await this.cache.cacheSet(cacheKey, result, 120);
    return result;
  }

  private async getMerchantByUser(userId: string) {
    const m = await this.prisma.merchants.findFirst({
      where: { user_id: userId },
    });
    if (!m)
      throw new BadRequestException(
        'Merchant account not found. Please apply first.',
      );
    return m;
  }

  private async invalidateMerchantCaches(userId: string) {
    await Promise.all([
      this.cache.cacheInvalidatePattern(`merchant-dashboard:${userId}`),
      this.cache.cacheInvalidatePattern(`merchant-profile:${userId}`),
      this.cache.cacheInvalidatePattern(`merchant-transactions:${userId}:*`),
      this.cache.cacheInvalidatePattern(`merchant-payouts:${userId}:*`),
      this.cache.cacheInvalidatePattern(`merchant-qr:${userId}`),
    ]);
  }
}
