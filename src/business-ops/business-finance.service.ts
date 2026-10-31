import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthService } from '../auth/auth.service';
import { paginate, paginationParams } from '../common/utils/pagination.util';
import { BusinessAccessService } from './business-access.service';
import { BusinessWebhooksService } from './business-webhooks.service';
import {
  businessWalletEnabled,
  personalWalletOf,
  settlementWalletFor,
} from './business-wallet';
import { generateTxReference } from '../common/utils/reference.util';

/** UI status -> stored transaction_status. */
export const TX_STATUS_MAP: Record<string, string> = {
  pending: 'pending',
  processing: 'processing',
  successful: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  refunded: 'reversed',
};
export function txStatusLabel(s?: string | null): string {
  switch (s) {
    case 'completed':
      return 'successful';
    case 'reversed':
      return 'refunded';
    default:
      return s || 'pending';
  }
}

const RANGE_DAYS: Record<string, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

@Injectable()
export class BusinessFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
    private readonly auth: AuthService,
    private readonly webhooks: BusinessWebhooksService,
  ) {}

  /**
   * The business settlement wallet. With BUSINESS_WALLET_ENABLED it is the
   * business's own merchant wallet; otherwise (legacy) the owner's personal wallet.
   */
  async walletFor(ownerUserId: string) {
    const w = await settlementWalletFor(this.prisma, { ownerUserId });
    if (!w) throw new NotFoundException('Business wallet not found');
    return w;
  }

  async wallet(userId: string) {
    const a = await this.access.resolve(userId, 'wallet:read');
    const w = await this.walletFor(a.business.owner_user_id);
    return {
      data: {
        id: w.id,
        wallet_address: w.wallet_address,
        currency: w.currency,
        balance: Number(w.balance),
        locked_balance: Number(w.locked_balance),
        available_balance: Math.max(
          0,
          Number(w.balance) - Number(w.locked_balance),
        ),
        is_frozen: w.is_frozen,
        kind: w.wallet_type === 'merchant' ? 'business' : 'personal',
        separate_from_personal: w.wallet_type === 'merchant',
        can_move_to_personal:
          businessWalletEnabled() &&
          w.wallet_type === 'merchant' &&
          a.role === 'owner',
      },
    };
  }

  /**
   * Owner-only, free internal move from the business wallet to the owner's
   * personal wallet (BUSINESS_WALLET_ENABLED). One DB transaction, PIN required.
   */
  async moveToPersonal(
    userId: string,
    dto: { amount: number; pin?: string; note?: string },
  ) {
    if (!businessWalletEnabled())
      throw new BadRequestException(
        'The business wallet is not switched on yet',
      );
    const a = await this.access.resolve(userId, 'wallet:read');
    if (a.role !== 'owner')
      throw new ForbiddenException(
        'Only the business owner can move funds to personal',
      );
    const amount = Number(dto.amount);
    if (!(amount > 0) || Math.round(amount * 100) / 100 !== amount)
      throw new BadRequestException('Amount must be positive (2 decimals)');
    if (!dto.pin) throw new BadRequestException('Transaction PIN is required');
    await this.auth.verifyPin(userId, dto.pin);
    const biz = await this.walletFor(a.business.owner_user_id);
    if (biz.wallet_type !== 'merchant')
      throw new BadRequestException('This business has no separate wallet yet');
    if (biz.is_frozen)
      throw new ForbiddenException('Business wallet is frozen');
    return this.prisma.$transaction(async (tx) => {
      const me = await personalWalletOf(tx, userId);
      if (!me || me.id === biz.id)
        throw new NotFoundException('Personal wallet not found');
      const took = await tx.wallets.updateMany({
        where: { id: biz.id, is_frozen: false },
        data: { balance: { decrement: amount } },
      });
      const after = await tx.wallets.findUnique({ where: { id: biz.id } });
      if (
        !took.count ||
        Number(after!.balance) - Number(after!.locked_balance) < 0
      )
        throw new BadRequestException('Not enough available business balance');
      const credited = await tx.wallets.update({
        where: { id: me.id },
        data: { balance: { increment: amount } },
      });
      const ref = generateTxReference();
      const t = await tx.transactions.create({
        data: {
          transaction_reference: ref,
          sender_wallet_id: biz.id,
          receiver_wallet_id: me.id,
          transaction_type: 'transfer',
          status: 'completed',
          amount,
          fee: 0,
          net_amount: amount,
          description:
            dto.note?.slice(0, 200) || 'Moved from business to personal',
          metadata: {
            kind: 'business_to_personal',
            business_id: a.business.id,
          },
          processed_at: new Date(),
        },
      });
      await tx.ledger_entries.createMany({
        data: [
          {
            transaction_id: t.id,
            wallet_id: biz.id,
            entry_type: 'debit',
            amount,
            balance_before: Number(after!.balance) + amount,
            balance_after: Number(after!.balance),
            description: 'Move to personal',
            category: 'business_to_personal',
          },
          {
            transaction_id: t.id,
            wallet_id: me.id,
            entry_type: 'credit',
            amount,
            balance_before: Number(credited.balance) - amount,
            balance_after: Number(credited.balance),
            description: 'From your business wallet',
            category: 'business_to_personal',
          },
        ],
      });
      return {
        data: {
          transaction_reference: ref,
          amount,
          fee: 0,
          business_balance: Number(after!.balance),
          personal_balance: Number(credited.balance),
        },
      };
    });
  }

  async dashboard(userId: string) {
    const a = await this.access.resolve(userId, 'dashboard:read');
    const bid = a.business.id;
    const w = await this.walletFor(a.business.owner_user_id);
    const since = new Date(Date.now() - 30 * 86400_000);
    const showMoney = ['owner', 'admin', 'finance', 'accountant'].includes(
      a.role,
    );
    const [
      inflow,
      outflow,
      openInvoices,
      activeLinks,
      pendingPayouts,
      openEscrows,
      recent,
    ] = await Promise.all([
      this.prisma.transactions.aggregate({
        where: {
          receiver_wallet_id: w.id,
          status: 'completed',
          created_at: { gte: since },
        },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.transactions.aggregate({
        where: {
          sender_wallet_id: w.id,
          status: 'completed',
          created_at: { gte: since },
        },
        _sum: { amount: true },
      }),
      this.prisma.business_invoices.aggregate({
        where: {
          business_id: bid,
          status: { in: ['sent', 'pending', 'overdue'] },
        },
        _sum: { total: true },
        _count: true,
      }),
      this.prisma.business_payment_links.count({
        where: { business_id: bid, is_active: true },
      }),
      a.business.merchant_id
        ? this.prisma.merchant_payouts.count({
            where: { merchant_id: a.business.merchant_id, status: 'pending' },
          })
        : Promise.resolve(0),
      this.prisma.business_escrows.count({
        where: {
          business_id: bid,
          status: {
            in: [
              'awaiting_payment',
              'funded',
              'in_progress',
              'release_requested',
              'disputed',
            ],
          },
        },
      }),
      this.prisma.business_payments.findMany({
        where: { business_id: bid },
        orderBy: { created_at: 'desc' },
        take: 5,
      }),
    ]);
    return {
      data: {
        role: a.role,
        wallet: showMoney
          ? {
              balance: Number(w.balance),
              available_balance: Math.max(
                0,
                Number(w.balance) - Number(w.locked_balance),
              ),
              currency: w.currency,
            }
          : null,
        last_30_days: showMoney
          ? {
              received: Number(inflow._sum.amount ?? 0),
              sent: Number(outflow._sum.amount ?? 0),
              payments_count: inflow._count,
            }
          : null,
        open_invoices: {
          count: openInvoices._count,
          total: Number(openInvoices._sum.total ?? 0),
        },
        active_payment_links: activeLinks,
        pending_payouts: pendingPayouts,
        open_escrows: openEscrows,
        recent_payments: recent.map((p) => ({
          ...p,
          amount: Number(p.amount),
        })),
      },
    };
  }

  async transactions(userId: string, q: any) {
    const a = await this.access.resolve(userId, 'transactions:read');
    const w = await this.walletFor(a.business.owner_user_id);
    const { skip, take, page, limit } = paginationParams(q.page, q.limit);
    const where: Prisma.transactionsWhereInput = {
      OR: [{ sender_wallet_id: w.id }, { receiver_wallet_id: w.id }],
    };
    if (q.status) {
      const s = TX_STATUS_MAP[String(q.status).toLowerCase()];
      if (!s) throw new BadRequestException('Unknown status filter');
      where.status = s as any;
    }
    if (q.direction === 'in') {
      delete where.OR;
      where.receiver_wallet_id = w.id;
    }
    if (q.direction === 'out') {
      delete where.OR;
      where.sender_wallet_id = w.id;
    }
    const [items, total] = await Promise.all([
      this.prisma.transactions.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.transactions.count({ where }),
    ]);
    return {
      data: items.map((t) => this.shapeTx(t, w.id)),
      meta: paginate(total, page, limit),
    };
  }

  async transaction(userId: string, id: string) {
    const a = await this.access.resolve(userId, 'transactions:read');
    const w = await this.walletFor(a.business.owner_user_id);
    const t = await this.prisma.transactions.findFirst({
      where: {
        id,
        OR: [{ sender_wallet_id: w.id }, { receiver_wallet_id: w.id }],
      },
      include: { ledger_entries: { where: { wallet_id: w.id } } },
    });
    if (!t) throw new NotFoundException('Transaction not found');
    const link = await this.prisma.business_payments.findUnique({
      where: { transaction_reference: t.transaction_reference },
    });
    return {
      data: {
        ...this.shapeTx(t, w.id),
        ledger: t.ledger_entries.map((l) => ({
          entry_type: l.entry_type,
          amount: Number(l.amount),
          balance_before: Number(l.balance_before),
          balance_after: Number(l.balance_after),
          created_at: l.created_at,
        })),
        business_payment: link
          ? { source: link.source, source_id: link.source_id }
          : null,
      },
    };
  }

  private shapeTx(t: any, walletId: string) {
    return {
      id: t.id,
      reference: t.transaction_reference,
      type: t.transaction_type,
      status: txStatusLabel(t.status),
      direction: t.receiver_wallet_id === walletId ? 'in' : 'out',
      amount: Number(t.amount),
      fee: Number(t.fee ?? 0),
      net_amount: Number(t.net_amount ?? 0),
      currency: t.currency,
      description: t.description,
      created_at: t.created_at,
      processed_at: t.processed_at,
    };
  }

  async payouts(userId: string, q: any) {
    const a = await this.access.resolve(userId, 'payouts:read');
    // Automatic payouts (dashboard + API) run through the withdrawal pipeline.
    const automatic = await this.prisma.business_api_payouts.findMany({
      where: { business_id: a.business.id },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    const auto = automatic.map((p) => {
      const r: any = (p.response as any)?.data ?? {};
      return {
        id: p.id,
        source: p.source,
        reference: p.withdrawal_reference,
        amount: Number(r.amount ?? 0),
        method: r.method ?? null,
        status:
          p.status === 'submitted'
            ? String(r.status ?? 'PROCESSING')
            : p.status === 'failed'
              ? 'FAILED'
              : 'PROCESSING',
        error: p.status === 'failed' ? p.error : null,
        created_at: p.created_at,
        automatic: true,
      };
    });
    if (!a.business.merchant_id)
      return { data: auto, meta: paginate(auto.length, 1, 100) };
    const { skip, take, page, limit } = paginationParams(q.page, q.limit);
    const where = { merchant_id: a.business.merchant_id };
    const [items, total] = await Promise.all([
      this.prisma.merchant_payouts.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.merchant_payouts.count({ where }),
    ]);
    return {
      data: [
        ...(page === 1 ? auto : []),
        ...items.map((p) => ({
          ...p,
          amount: Number(p.amount),
          status: txStatusLabel(p.status),
          automatic: false,
        })),
      ],
      meta: paginate(total, page, limit),
    };
  }

  async analytics(userId: string, range: string) {
    const days = RANGE_DAYS[range];
    if (!days)
      throw new BadRequestException('range must be one of 7d, 30d, 90d, 1y');
    const a = await this.access.resolve(userId, 'analytics:read');
    const w = await this.walletFor(a.business.owner_user_id);
    const since = new Date(Date.now() - days * 86400_000);
    const bucket = range === '1y' ? 'month' : 'day';
    const rows = await this.prisma.$queryRaw<
      { bucket: Date; received: any; sent: any; count_in: bigint }[]
    >(Prisma.sql`
      SELECT date_trunc(${bucket}, created_at) AS bucket,
             COALESCE(SUM(CASE WHEN receiver_wallet_id = ${w.id}::uuid THEN amount END), 0) AS received,
             COALESCE(SUM(CASE WHEN sender_wallet_id = ${w.id}::uuid THEN amount END), 0) AS sent,
             COUNT(*) FILTER (WHERE receiver_wallet_id = ${w.id}::uuid) AS count_in
      FROM transactions
      WHERE status = 'completed' AND created_at >= ${since}
        AND (receiver_wallet_id = ${w.id}::uuid OR sender_wallet_id = ${w.id}::uuid)
      GROUP BY 1 ORDER BY 1`);
    const [invoicesPaid, linkPayments, customers] = await Promise.all([
      this.prisma.business_invoices.count({
        where: {
          business_id: a.business.id,
          status: 'paid',
          paid_at: { gte: since },
        },
      }),
      this.prisma.business_payments.count({
        where: {
          business_id: a.business.id,
          source: 'payment_link',
          created_at: { gte: since },
        },
      }),
      this.prisma.business_customers.count({
        where: { business_id: a.business.id, created_at: { gte: since } },
      }),
    ]);
    const series = rows.map((r) => ({
      period: r.bucket,
      received: Number(r.received),
      sent: Number(r.sent),
      payments: Number(r.count_in),
    }));
    return {
      data: {
        range,
        bucket,
        series,
        totals: {
          received: series.reduce((s, r) => s + r.received, 0),
          sent: series.reduce((s, r) => s + r.sent, 0),
          payments: series.reduce((s, r) => s + r.payments, 0),
          invoices_paid: invoicesPaid,
          payment_link_payments: linkPayments,
          new_customers: customers,
        },
        empty: series.length === 0,
      },
    };
  }
}
