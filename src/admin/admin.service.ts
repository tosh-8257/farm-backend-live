import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EscrowService } from '../escrow/escrow.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WithdrawService } from '../withdraw/withdraw.service';
import { paginationParams, paginate } from '../common/utils/pagination.util';
import { CurrencyConversionService } from '../currency/currency-conversion.service';
import { enrichAdminListItem } from './admin-response-utils';
import { CacheService } from '../common/cache/cache.service';

const EXCHANGE_RATES_CACHE_KEY = 'exchange-rates:all';
const EXCHANGE_RATES_CACHE_TTL_SECONDS = 300;

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private escrowService: EscrowService,
    private notifications: NotificationsService,
    private withdrawService: WithdrawService,
    private readonly currencyConversionService: CurrencyConversionService,
    @Optional() private readonly cache?: CacheService,
  ) {}

  async getDashboardStats() {
    const [
      totalUsers,
      totalMerchants,
      activeEscrows,
      txVolume,
      pendingKyc,
      pendingPayouts,
    ] = await Promise.all([
      this.prisma.users.count({
        where: {
          is_deleted: false,
          OR: [{ role: { notIn: ['admin', 'super_admin'] } }, { role: null }],
        },
      }),
      this.prisma.merchants.count({ where: { status: 'approved' } }),
      this.prisma.escrow_contracts.count({ where: { status: 'active' } }),
      this.prisma.transactions.aggregate({
        where: { status: 'completed' },
        _sum: { amount: true },
        _count: true,
      }),
      this.prisma.kyc_documents.count({ where: { status: 'pending' } }),
      this.prisma.merchant_payouts.count({ where: { status: 'pending' } }),
    ]);
    return {
      data: {
        total_users: totalUsers,
        total_merchants: totalMerchants,
        active_escrows: activeEscrows,
        total_tx_volume: Number(txVolume._sum.amount ?? 0),
        total_transactions: txVolume._count,
        pending_kyc: pendingKyc,
        pending_payouts: pendingPayouts,
      },
    };
  }

  async listUsers(query: any) {
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const where: any = {
      is_deleted: false,
      AND: [
        {
          OR: [{ role: { notIn: ['admin', 'super_admin'] } }, { role: null }],
        },
      ],
    };
    if (query.search) {
      where.AND.push({
        OR: [
          { username: { contains: query.search, mode: 'insensitive' } },
          { phone: { contains: query.search } },
          { email: { contains: query.search, mode: 'insensitive' } },
        ],
      });
    }
    if (query.role) where.role = query.role;
    if (query.kyc_status) where.kyc_status = query.kyc_status;

    const [users, total] = await Promise.all([
      this.prisma.users.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          username: true,
          email: true,
          phone: true,
          role: true,
          kyc_status: true,
          is_active: true,
          is_suspended: true,
          created_at: true,
          wallets: { select: { balance: true }, take: 1 },
        },
      }),
      this.prisma.users.count({ where }),
    ]);
    return {
      data: users.map((u) => ({
        ...u,
        balance: Number(u.wallets[0]?.balance ?? 0),
      })),
      meta: paginate(total, page, limit),
    };
  }

  async listTransactions(query: any) {
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const where: any = {};

    if (query.status) where.status = query.status;
    if (query.transaction_type || query.type)
      where.transaction_type = query.transaction_type ?? query.type;
    if (query.search) {
      where.OR = [
        {
          transaction_reference: {
            contains: query.search,
            mode: 'insensitive',
          },
        },
        { description: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.transactions.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
        include: {
          wallets_transactions_sender_wallet_idTowallets: {
            select: {
              wallet_address: true,
              user_id: true,
              users: {
                select: {
                  id: true,
                  username: true,
                  first_name: true,
                  last_name: true,
                  email: true,
                  phone: true,
                },
              },
            },
          },
          wallets_transactions_receiver_wallet_idTowallets: {
            select: {
              wallet_address: true,
              user_id: true,
              users: {
                select: {
                  id: true,
                  username: true,
                  first_name: true,
                  last_name: true,
                  email: true,
                  phone: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.transactions.count({ where }),
    ]);

    const metadataUserIds = items
      .map((tx) => {
        const metadata = tx.metadata;
        if (
          !metadata ||
          typeof metadata !== 'object' ||
          Array.isArray(metadata)
        )
          return null;
        const values = metadata as Record<string, unknown>;
        return values.user_id ?? values.userId;
      })
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    const walletUserIds = new Set(
      items
        .flatMap((tx) => [
          tx.wallets_transactions_sender_wallet_idTowallets?.user_id,
          tx.wallets_transactions_receiver_wallet_idTowallets?.user_id,
        ])
        .filter((id): id is string => Boolean(id)),
    );
    const missingUserIds = [...new Set(metadataUserIds)].filter(
      (id) => !walletUserIds.has(id),
    );
    const metadataUsers = missingUserIds.length
      ? await this.prisma.users.findMany({
          where: { id: { in: missingUserIds } },
          select: {
            id: true,
            username: true,
            first_name: true,
            last_name: true,
            email: true,
            phone: true,
          },
        })
      : [];
    const metadataUsersById = new Map(
      metadataUsers.map((user) => [user.id, user]),
    );
    const userName = (
      user:
        | {
            first_name?: string | null;
            last_name?: string | null;
            username?: string | null;
          }
        | null
        | undefined,
    ) =>
      user
        ? [user.first_name, user.last_name].filter(Boolean).join(' ') ||
          user.username ||
          null
        : null;

    return {
      data: items.map((tx) => {
        const senderWallet = tx.wallets_transactions_sender_wallet_idTowallets;
        const receiverWallet =
          tx.wallets_transactions_receiver_wallet_idTowallets;
        const metadata =
          tx.metadata &&
          typeof tx.metadata === 'object' &&
          !Array.isArray(tx.metadata)
            ? (tx.metadata as Record<string, any>)
            : {};
        const metadataUserId = metadata.user_id ?? metadata.userId;
        const linkedUserId =
          senderWallet?.user_id ?? receiverWallet?.user_id ?? metadataUserId;
        const linkedUser =
          senderWallet?.users ??
          receiverWallet?.users ??
          (typeof metadataUserId === 'string'
            ? metadataUsersById.get(metadataUserId)
            : undefined);
        const type = String(tx.transaction_type).toLowerCase();
        const userDisplayName = userName(linkedUser);
        const senderName =
          userName(senderWallet?.users) ??
          metadata.sender_name ??
          metadata.sender_username ??
          senderWallet?.wallet_address ??
          (type === 'deposit'
            ? (metadata.payment_provider ??
              metadata.provider ??
              'External payment provider')
            : type.includes('withdraw')
              ? (userDisplayName ?? 'Account holder')
              : 'External sender');
        const receiverName =
          userName(receiverWallet?.users) ??
          metadata.receiver_name ??
          metadata.recipient_name ??
          receiverWallet?.wallet_address ??
          (type === 'deposit'
            ? (userDisplayName ?? 'Deposit account')
            : type.includes('withdraw')
              ? (metadata.destination ??
                metadata.crypto_address ??
                metadata.account_number ??
                'Withdrawal destination')
              : 'External recipient');

        return enrichAdminListItem(
          {
            id: tx.id,
            transaction_reference: tx.transaction_reference,
            transaction_type: tx.transaction_type,
            status: tx.status,
            amount: Number(tx.amount),
            fee: Number(tx.fee ?? 0),
            net_amount: Number(tx.net_amount ?? 0),
            currency: tx.currency,
            description: tx.description,
            metadata,
            created_at: tx.created_at,
            processed_at: tx.processed_at,
            sender_wallet: senderWallet?.wallet_address,
            receiver_wallet: receiverWallet?.wallet_address,
            sender_user_id:
              senderWallet?.user_id ??
              (type.includes('withdraw') ? linkedUserId : null),
            receiver_user_id:
              receiverWallet?.user_id ??
              (type === 'deposit' ? linkedUserId : null),
            sender_name: String(senderName),
            receiver_name: String(receiverName),
            user_id: linkedUserId,
          },
          linkedUser,
        );
      }),
      meta: paginate(total, page, limit),
    };
  }

  async getTransactionDetails(transactionId: string) {
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        transactionId,
      );
    const tx = await this.prisma.transactions.findFirst({
      where: {
        OR: [
          ...(isUuid ? [{ id: transactionId }] : []),
          { transaction_reference: transactionId },
        ],
      },
      include: {
        wallets_transactions_sender_wallet_idTowallets: {
          select: {
            wallet_address: true,
            user_id: true,
            users: {
              select: {
                id: true,
                username: true,
                first_name: true,
                last_name: true,
                email: true,
                phone: true,
              },
            },
          },
        },
        wallets_transactions_receiver_wallet_idTowallets: {
          select: {
            wallet_address: true,
            user_id: true,
            users: {
              select: {
                id: true,
                username: true,
                first_name: true,
                last_name: true,
                email: true,
                phone: true,
              },
            },
          },
        },
      },
    });
    if (!tx) throw new NotFoundException('Transaction not found');

    const senderWallet = tx.wallets_transactions_sender_wallet_idTowallets;
    const receiverWallet = tx.wallets_transactions_receiver_wallet_idTowallets;
    const metadata =
      tx.metadata &&
      typeof tx.metadata === 'object' &&
      !Array.isArray(tx.metadata)
        ? (tx.metadata as Record<string, any>)
        : {};
    const metadataUserId = metadata.user_id ?? metadata.userId;
    const linkedUserId =
      senderWallet?.user_id ??
      receiverWallet?.user_id ??
      (typeof metadataUserId === 'string' ? metadataUserId : null);
    const linkedUser =
      senderWallet?.users ??
      receiverWallet?.users ??
      (linkedUserId
        ? await this.prisma.users.findUnique({
            where: { id: linkedUserId },
            select: {
              id: true,
              username: true,
              first_name: true,
              last_name: true,
              email: true,
              phone: true,
            },
          })
        : null);
    const userName = (
      user:
        | {
            first_name?: string | null;
            last_name?: string | null;
            username?: string | null;
          }
        | null
        | undefined,
    ) =>
      user
        ? [user.first_name, user.last_name].filter(Boolean).join(' ') ||
          user.username ||
          null
        : null;
    const type = String(tx.transaction_type).toLowerCase();
    const userDisplayName = userName(linkedUser);
    const senderName =
      userName(senderWallet?.users) ??
      metadata.sender_name ??
      metadata.sender_username ??
      senderWallet?.wallet_address ??
      (type === 'deposit'
        ? (metadata.payment_provider ??
          metadata.provider ??
          'External payment provider')
        : type.includes('withdraw')
          ? (userDisplayName ?? 'Account holder')
          : 'External sender');
    const receiverName =
      userName(receiverWallet?.users) ??
      metadata.receiver_name ??
      metadata.recipient_name ??
      receiverWallet?.wallet_address ??
      (type === 'deposit'
        ? (userDisplayName ?? 'Deposit account')
        : type.includes('withdraw')
          ? (metadata.destination ??
            metadata.crypto_address ??
            metadata.account_number ??
            'Withdrawal destination')
          : 'External recipient');

    return {
      data: enrichAdminListItem(
        {
          ...tx,
          amount: Number(tx.amount),
          fee: Number(tx.fee ?? 0),
          net_amount: Number(tx.net_amount ?? 0),
          metadata,
          sender_wallet: senderWallet?.wallet_address,
          receiver_wallet: receiverWallet?.wallet_address,
          sender_user_id: senderWallet?.user_id ?? null,
          receiver_user_id: receiverWallet?.user_id ?? null,
          sender_name: String(senderName),
          receiver_name: String(receiverName),
          user_id: linkedUserId,
        },
        linkedUser,
      ),
    };
  }

  async getUserDetail(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      include: {
        wallets: true,
        // Correct relation names from generated Prisma client
        kyc_documents_kyc_documents_user_idTousers: {
          orderBy: { created_at: 'desc' },
          take: 1,
        },
        merchants_merchants_user_idTousers: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return { data: user };
  }

  async updateUserStatus(
    userId: string,
    dto: { is_active?: boolean; is_suspended?: boolean },
    adminId: string,
  ) {
    const user = await this.prisma.users.update({
      where: { id: userId },
      data: dto,
    });
    await this.prisma.audit_logs.create({
      data: {
        user_id: adminId,
        action: 'UPDATE_USER_STATUS',
        entity_type: 'users',
        entity_id: userId,
        new_values: dto as any,
      },
    });
    return { data: user, message: 'User status updated' };
  }

  async listAllEscrows(query: any) {
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const where: any = {};
    if (query.status) where.status = query.status;
    const [items, total] = await Promise.all([
      this.prisma.escrow_contracts.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
        include: {
          users_escrow_contracts_buyer_idTousers: {
            select: { username: true },
          },
          users_escrow_contracts_seller_idTousers: {
            select: { username: true },
          },
        },
      }),
      this.prisma.escrow_contracts.count({ where }),
    ]);
    return {
      data: items.map((e) => ({
        ...e,
        amount: Number(e.amount),
        fee: Number(e.fee),
      })),
      meta: paginate(total, page, limit),
    };
  }

  async resolveDispute(
    escrowId: string,
    adminId: string,
    dto: { winner: 'buyer' | 'seller'; note: string },
  ) {
    const escrow = await this.prisma.escrow_contracts.findUnique({
      where: { id: escrowId },
    });
    if (!escrow) throw new NotFoundException('Escrow not found');
    if (escrow.status !== 'disputed') {
      throw new BadRequestException('Only disputed escrows can be resolved');
    }
    const resolution = { adminId, note: dto.note };
    if (dto.winner === 'seller') {
      await this.escrowService.executeRelease(escrow, resolution);
    } else {
      await this.escrowService.executeRefund(escrow, resolution);
    }
    await this.prisma.audit_logs.create({
      data: {
        user_id: adminId,
        action: 'RESOLVE_DISPUTE',
        entity_type: 'escrow_contracts',
        entity_id: escrowId,
        new_values: dto as any,
      },
    });
    return { message: `Escrow resolved in favour of ${dto.winner}` };
  }

  async getEscrow(escrowId: string) {
    const escrow = await this.prisma.escrow_contracts.findUnique({
      where: { id: escrowId },
      include: {
        users_escrow_contracts_buyer_idTousers: {
          select: { id: true, username: true, email: true },
        },
        users_escrow_contracts_seller_idTousers: {
          select: { id: true, username: true, email: true },
        },
        escrow_messages: { orderBy: { created_at: 'asc' } },
      },
    });
    if (!escrow) throw new NotFoundException('Escrow not found');
    return {
      data: {
        ...escrow,
        amount: Number(escrow.amount),
        fee: Number(escrow.fee ?? 0),
      },
    };
  }

  async listMerchants(query: any) {
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const where: any = {};
    if (query.status) where.status = query.status;
    const [items, total] = await Promise.all([
      this.prisma.merchants.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
        include: {
          users_merchants_user_idTousers: {
            select: { username: true, email: true, phone: true },
          },
        },
      }),
      this.prisma.merchants.count({ where }),
    ]);
    return {
      data: items.map((merchant) => ({
        ...merchant,
        email:
          merchant.users_merchants_user_idTousers?.email ??
          merchant.business_email,
        phone:
          merchant.users_merchants_user_idTousers?.phone ??
          merchant.business_phone,
        applicant_username: merchant.users_merchants_user_idTousers?.username,
      })),
      meta: paginate(total, page, limit),
    };
  }

  async getMerchant(merchantId: string) {
    const [merchant, decisions] = await Promise.all([
      this.prisma.merchants.findUnique({
        where: { id: merchantId },
        include: {
          users_merchants_user_idTousers: {
            select: {
              id: true,
              username: true,
              email: true,
              phone: true,
              first_name: true,
              last_name: true,
            },
          },
          merchant_payouts: { orderBy: { created_at: 'desc' }, take: 5 },
        },
      }),
      this.prisma.audit_logs.findMany({
        where: { entity_type: 'merchants', entity_id: merchantId },
        orderBy: { created_at: 'desc' },
        select: {
          action: true,
          new_values: true,
          created_at: true,
          user_id: true,
        },
      }),
    ]);

    if (!merchant) throw new NotFoundException('Merchant not found');

    return {
      data: {
        ...merchant,
        total_sales: Number(merchant.total_sales ?? 0),
        daily_limit: Number(merchant.daily_limit ?? 0),
        transaction_fee_percent: Number(merchant.transaction_fee_percent ?? 0),
        decision_history: decisions,
      },
    };
  }

  async approveMerchant(
    merchantId: string,
    adminId: string,
    dto: { status: 'approved' | 'rejected'; rejection_reason?: string },
  ) {
    const merchant = await this.prisma.merchants.update({
      where: { id: merchantId },
      data: {
        status: dto.status as any,
        approved_by: adminId,
        approved_at: new Date(),
      },
    });
    await this.prisma.audit_logs.create({
      data: {
        user_id: adminId,
        action: `MERCHANT_${dto.status.toUpperCase()}`,
        entity_type: 'merchants',
        entity_id: merchantId,
        new_values: dto as any,
      },
    });

    if (merchant.user_id) {
      const approved = dto.status === 'approved';
      const title = approved
        ? 'Merchant application approved'
        : 'Merchant application not approved';
      const body = approved
        ? 'Your merchant application has been approved. You can now access the Merchant Portal.'
        : `Your merchant application was not approved.${dto.rejection_reason ? ` Reason: ${dto.rejection_reason}` : ''} Please review your details and submit again.`;
      await this.notifications.sendNotification(merchant.user_id, {
        type: 'merchant',
        entityId: merchant.id,
        title,
        body,
        metadata: {
          merchantId: merchant.id,
          status: dto.status,
          rejectionReason: dto.rejection_reason ?? '',
        },
      });
    }

    return { data: merchant, message: `Merchant ${dto.status}` };
  }

  async getFees() {
    const fees = await this.prisma.fee_configurations.findMany({
      orderBy: { created_at: 'desc' },
    });

    return {
      data: fees.map((fee) => ({
        ...fee,
        flat_fee: Number(fee.flat_fee ?? 0),
        percentage_fee: Number(fee.percentage_fee ?? 0),
        minimum_fee: Number(fee.minimum_fee ?? 0),
        maximum_fee: Number(fee.maximum_fee ?? 0),
        value:
          fee.percentage_fee?.toString() ?? fee.flat_fee?.toString() ?? '0',
      })),
    };
  }

  async updateFee(feeId: string, value: string, adminId: string) {
    const fee = await this.prisma.fee_configurations.findUnique({
      where: { id: feeId },
    });
    if (!fee) throw new NotFoundException('Fee configuration not found');

    const numericValue = Number(value);
    if (Number.isNaN(numericValue)) {
      throw new BadRequestException('Fee value must be numeric');
    }

    const updated = await this.prisma.fee_configurations.update({
      where: { id: feeId },
      data: {
        percentage_fee: numericValue,
        flat_fee: 0,
        minimum_fee: 0,
        maximum_fee: 0,
      },
    });

    await this.prisma.audit_logs.create({
      data: {
        user_id: adminId,
        action: 'UPDATE_FEE',
        entity_type: 'fee_configurations',
        entity_id: feeId,
        new_values: { value },
      },
    });

    return {
      data: {
        ...updated,
        flat_fee: Number(updated.flat_fee ?? 0),
        percentage_fee: Number(updated.percentage_fee ?? 0),
        minimum_fee: Number(updated.minimum_fee ?? 0),
        maximum_fee: Number(updated.maximum_fee ?? 0),
      },
      message: 'Fee updated',
    };
  }

  async listPayouts(query: any) {
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const where: any = {};
    if (query.status) where.status = query.status;
    const [items, total] = await Promise.all([
      this.prisma.merchant_payouts.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
        include: {
          merchants: { select: { business_name: true } },
        },
      }),
      this.prisma.merchant_payouts.count({ where }),
    ]);
    return {
      data: items.map((p) => ({ ...p, amount: Number(p.amount) })),
      meta: paginate(total, page, limit),
    };
  }

  async listAllWithdrawals(query: any) {
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const where: any = {};
    if (query.status) where.status = query.status;
    const [items, total] = await Promise.all([
      this.prisma.withdrawal.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              first_name: true,
              last_name: true,
              email: true,
              phone: true,
            },
          },
        },
      }),
      this.prisma.withdrawal.count({ where }),
    ]);
    return {
      data: items.map((w) => {
        const { user, ...withdrawal } = w;
        const destination = [
          w.cryptoAsset,
          w.network,
          w.cryptoAddress,
          w.bankName,
          w.accountName,
          w.accountNumber ? `Account ${w.accountNumber}` : null,
          w.phoneNumber,
        ]
          .filter(Boolean)
          .join(' · ');
        const senderName =
          [user.first_name, user.last_name].filter(Boolean).join(' ') ||
          user.username ||
          user.email ||
          user.phone;
        return enrichAdminListItem(
          {
            ...withdrawal,
            amount: Number(w.amount),
            currency: w.currency,
            sender_name: senderName,
            sender_user_id: user.id,
            receiver_name: destination || 'Withdrawal destination unavailable',
            receiver_identifier: destination || null,
          },
          user,
        );
      }),
      meta: paginate(total, page, limit),
    };
  }

  async processPayout(
    payoutId: string,
    adminId: string,
    status: 'completed' | 'failed',
  ) {
    const payout = await this.prisma.merchant_payouts.update({
      where: { id: payoutId },
      data: {
        status: status as any,
        processed_by: adminId,
        processed_at: new Date(),
      },
    });
    return { data: payout, message: `Payout marked ${status}` };
  }

  async sendNotification(
    adminId: string,
    dto: {
      user_id: string;
      title: string;
      body: string;
      type?: string;
      metadata?: any;
      push?: boolean;
      email?: boolean;
      sms?: boolean;
    },
  ) {
    const user = await this.prisma.users.findUnique({
      where: { id: dto.user_id },
    });
    if (!user) throw new NotFoundException('User not found');

    await this.notifications.createInApp(dto.user_id, {
      type: dto.type ?? 'admin',
      title: dto.title,
      body: dto.body,
      metadata: dto.metadata,
    });

    if (dto.push) {
      await this.notifications.sendPush(
        dto.user_id,
        dto.title,
        dto.body,
        dto.metadata,
      );
    }
    if (dto.email && user.email) {
      await this.notifications.sendEmail(
        user.email,
        dto.title,
        `<p>${dto.body}</p>`,
      );
    }
    if (dto.sms && user.phone) {
      await this.notifications.sendSms(user.phone, dto.body);
    }

    await this.prisma.audit_logs.create({
      data: {
        user_id: adminId,
        action: 'SEND_NOTIFICATION',
        entity_type: 'users',
        entity_id: dto.user_id,
        new_values: {
          title: dto.title,
          body: dto.body,
          type: dto.type,
          push: dto.push,
          email: dto.email,
          sms: dto.sms,
        },
      },
    });

    return { message: 'Notification sent' };
  }

  async broadcastNotification(
    adminId: string,
    dto: {
      title: string;
      body: string;
      type?: string;
      metadata?: any;
      push?: boolean;
      email?: boolean;
      sms?: boolean;
      audience?: string;
      target_role?: string;
      recipientIds?: string[];
      recipientEmails?: string[];
      recipientPhones?: string[];
    },
  ) {
    const where: any = { is_deleted: false, is_active: true };
    const audience =
      dto.audience?.trim().toLowerCase() ||
      dto.target_role?.trim().toLowerCase();

    if (
      dto.recipientIds?.length ||
      dto.recipientEmails?.length ||
      dto.recipientPhones?.length
    ) {
      where.OR = [];
      if (dto.recipientIds?.length) {
        where.OR.push({ id: { in: dto.recipientIds } });
      }
      if (dto.recipientEmails?.length) {
        where.OR.push({ email: { in: dto.recipientEmails } });
      }
      if (dto.recipientPhones?.length) {
        where.OR.push({ phone: { in: dto.recipientPhones } });
      }
    } else if (audience === 'verified') {
      where.kyc_status = 'verified';
    } else if (audience === 'merchants') {
      where.role = 'merchant';
    } else if (audience === 'investors') {
      where.role = 'user';
    } else if (audience && audience !== 'all') {
      where.role = audience;
    }

    const users = await this.prisma.users.findMany({
      where,
      select: { id: true, email: true, phone: true },
    });

    const shouldPush = dto.push ?? true;
    const shouldEmail = dto.email ?? false;
    const shouldSms = dto.sms ?? false;

    await Promise.all(
      users.map((user) =>
        this.notifications.sendNotification(user.id, {
          type: dto.type ?? 'system_announcement',
          title: dto.title,
          body: dto.body,
          metadata: {
            ...(dto.metadata ?? {}),
            audience: audience || 'custom',
            sentBy: adminId,
          },
        }),
      ),
    );

    if (shouldPush) {
      await Promise.all(
        users.map((user) =>
          this.notifications.sendPush(user.id, dto.title, dto.body, {
            ...(dto.metadata ?? {}),
            audience: audience || 'custom',
            sentBy: adminId,
          }),
        ),
      );
    }
    if (shouldEmail) {
      await Promise.all(
        users
          .filter((u) => u.email)
          .map((user) =>
            this.notifications.sendEmail(
              user.email!,
              dto.title,
              `<p>${dto.body}</p>`,
            ),
          ),
      );
    }
    if (shouldSms) {
      await Promise.all(
        users
          .filter((u) => u.phone)
          .map((user) => this.notifications.sendSms(user.phone!, dto.body)),
      );
    }

    await this.prisma.audit_logs.create({
      data: {
        user_id: adminId,
        action: 'BROADCAST_NOTIFICATION',
        entity_type: 'users',
        entity_id: null,
        new_values: {
          title: dto.title,
          body: dto.body,
          type: dto.type,
          push: shouldPush,
          email: shouldEmail,
          sms: shouldSms,
          audience: audience || 'custom',
          target_role: dto.target_role,
          recipientIds: dto.recipientIds,
          recipientEmails: dto.recipientEmails,
          recipientPhones: dto.recipientPhones,
        },
      },
    });

    return { message: `Broadcast sent to ${users.length} users` };
  }

  async getAdminAnalytics() {
    const periodStart = new Date();
    periodStart.setHours(0, 0, 0, 0);
    periodStart.setDate(periodStart.getDate() - 6);

    const [
      totalUsers,
      totalEscrows,
      totalTransactions,
      pendingKyc,
      pendingPayouts,
      totalSecurityEvents,
    ] = await Promise.all([
      this.prisma.users.count({
        where: {
          is_deleted: false,
          OR: [{ role: { notIn: ['admin', 'super_admin'] } }, { role: null }],
        },
      }),
      this.prisma.escrow_contracts.count({ where: {} }),
      this.prisma.transactions.count({ where: {} }),
      this.prisma.kyc_documents.count({ where: { status: 'pending' } }),
      this.prisma.merchant_payouts.count({ where: { status: 'pending' } }),
      this.prisma.security_events.count(),
    ]);

    const recentRevenueTransactions = await this.prisma.transactions.findMany({
      where: {
        status: 'completed',
        created_at: { gte: periodStart },
      },
      select: {
        amount: true,
        fee: true,
        created_at: true,
      },
    });

    const revenueByDay = new Map<string, number>();
    for (let offset = 0; offset < 7; offset++) {
      const day = new Date(periodStart);
      day.setDate(periodStart.getDate() + offset);
      revenueByDay.set(day.toISOString().slice(0, 10), 0);
    }
    for (const transaction of recentRevenueTransactions) {
      const key = (transaction.created_at ?? new Date())
        .toISOString()
        .slice(0, 10);
      revenueByDay.set(
        key,
        (revenueByDay.get(key) ?? 0) + Number(transaction.fee ?? 0),
      );
    }

    const revenue_series = Array.from(revenueByDay.entries()).map(
      ([date, value]) => ({
        date,
        label: date.slice(5),
        value: Number(value.toFixed(2)),
      }),
    );

    const recentTransactions = await this.prisma.transactions.findMany({
      orderBy: { created_at: 'desc' },
      take: 5,
      select: {
        id: true,
        transaction_reference: true,
        transaction_type: true,
        amount: true,
        net_amount: true,
        status: true,
        created_at: true,
      },
    });

    return {
      data: {
        total_users: totalUsers,
        total_escrows: totalEscrows,
        total_transactions: totalTransactions,
        pending_kyc: pendingKyc,
        pending_payouts: pendingPayouts,
        security_events: totalSecurityEvents,
        revenue_series,
        recent_transactions: recentTransactions.map((tx) => ({
          ...tx,
          amount: Number(tx.amount),
          net_amount: Number(tx.net_amount ?? 0),
        })),
      },
    };
  }

  async getSettings() {
    return {
      data: await this.prisma.system_settings.findMany({
        orderBy: { setting_key: 'asc' },
      }),
    };
  }

  async getExchangeRates() {
    const cached = await this.cache?.cacheGet<{ data: unknown[] }>(
      EXCHANGE_RATES_CACHE_KEY,
    );
    if (cached) return cached;
    const rates = await this.prisma.exchange_rates.findMany({
      orderBy: [{ base_currency: 'asc' }, { target_currency: 'asc' }],
    });
    const result = { data: rates };
    await this.cache?.cacheSet(
      EXCHANGE_RATES_CACHE_KEY,
      result,
      EXCHANGE_RATES_CACHE_TTL_SECONDS,
    );
    return result;
  }

  async getCurrencyRates() {
    const data = await this.prisma.currency_rates.findMany({
      orderBy: { effective_at: 'desc' },
    });
    return { data };
  }

  async getCurrentCurrencyRate() {
    const rate = await this.currencyConversionService.getCurrentRate();
    return { data: rate };
  }

  async updateCurrencyRate(usdKesRate: number, adminId: string) {
    const rate = await this.currencyConversionService.updateActiveRate(
      usdKesRate,
      adminId,
    );
    return { data: rate, message: 'Currency conversion rate updated' };
  }

  async updateExchangeRates(
    rates: { base_currency: string; target_currency: string; rate: number }[],
    adminId: string,
  ): Promise<{ data: any[]; message: string }> {
    const upserted = [] as any[];
    for (const rate of rates) {
      const base = rate.base_currency.toUpperCase();
      const target = rate.target_currency.toUpperCase();
      const existing = await this.prisma.exchange_rates.findFirst({
        where: { base_currency: base, target_currency: target },
        orderBy: { fetched_at: 'desc' },
      });
      if (existing) {
        const entry = await this.prisma.exchange_rates.update({
          where: { id: existing.id },
          data: { rate: rate.rate, fetched_at: new Date() },
        });
        upserted.push(entry as any);
      } else {
        const entry = await this.prisma.exchange_rates.create({
          data: {
            base_currency: base,
            target_currency: target,
            rate: rate.rate,
            fetched_at: new Date(),
          },
        });
        upserted.push(entry as any);
      }
    }
    await this.cache?.cacheDelete(EXCHANGE_RATES_CACHE_KEY);
    return { data: upserted, message: 'Exchange rates updated' };
  }

  async updateSetting(key: string, value: string, adminId: string) {
    const setting = await this.prisma.system_settings.upsert({
      where: { setting_key: key },
      update: { setting_value: value, updated_by: adminId },
      create: { setting_key: key, setting_value: value, updated_by: adminId },
    });
    return { data: setting, message: 'Setting updated' };
  }

  async getAuditLogs(query: any) {
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const [items, total] = await Promise.all([
      this.prisma.audit_logs.findMany({
        skip,
        take,
        orderBy: { created_at: 'desc' },
        include: { users: { select: { username: true } } },
      }),
      this.prisma.audit_logs.count(),
    ]);
    return { data: items, meta: paginate(total, page, limit) };
  }

  async createProject(adminId: string, dto: any) {
    const project = await this.prisma.investment_projects.create({
      data: { ...dto, created_by: adminId },
    });
    return { data: project, message: 'Investment project created' };
  }

  async updateProject(id: string, dto: any) {
    return {
      data: await this.prisma.investment_projects.update({
        where: { id },
        data: dto,
      }),
    };
  }

  // ── Audit Dashboard ──────────────────────────────────────────────────────────
  async getAuditDashboard() {
    const [securityEvents, activityLogs, userSessions, auditLogs] =
      await Promise.all([
        this.prisma.security_events.findMany({
          orderBy: { created_at: 'desc' },
          take: 5,
          include: { users: { select: { username: true, email: true } } },
        }),
        this.prisma.activity_logs.findMany({
          orderBy: { created_at: 'desc' },
          take: 10,
          include: { users: { select: { username: true, phone: true } } },
        }),
        this.prisma.user_sessions.findMany({
          where: { is_revoked: false },
          orderBy: { created_at: 'desc' },
          take: 5,
        }),
        this.prisma.audit_logs.findMany({
          orderBy: { created_at: 'desc' },
          take: 5,
          include: { users: { select: { username: true } } },
        }),
      ]);

    const securityEventCounts = await this.prisma.security_events.groupBy({
      by: ['event_type'],
      _count: true,
      orderBy: { _count: { event_type: 'desc' } },
    });

    return {
      data: {
        recent_security_events: securityEvents,
        recent_activities: activityLogs,
        active_sessions: userSessions,
        recent_audit_logs: auditLogs,
        security_event_summary: securityEventCounts,
      },
    };
  }

  async getSecurityEvents(query: any) {
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const where: any = {};

    if (query.severity) where.severity = query.severity;
    if (query.event_type) where.event_type = query.event_type;
    if (query.user_id) where.user_id = query.user_id;

    if (query.start_date || query.end_date) {
      where.created_at = {};
      if (query.start_date) where.created_at.gte = new Date(query.start_date);
      if (query.end_date) where.created_at.lte = new Date(query.end_date);
    }

    const [events, total] = await Promise.all([
      this.prisma.security_events.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
        include: {
          users: { select: { username: true, email: true, phone: true } },
        },
      }),
      this.prisma.security_events.count({ where }),
    ]);

    return {
      data: events,
      meta: paginate(total, page, limit),
    };
  }

  async getUserActivityLog(userId: string, query: any) {
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );

    const [logs, total] = await Promise.all([
      this.prisma.activity_logs.findMany({
        where: { user_id: userId },
        skip,
        take,
        orderBy: { created_at: 'desc' },
        include: { users: { select: { username: true, email: true } } },
      }),
      this.prisma.activity_logs.count({ where: { user_id: userId } }),
    ]);

    return {
      data: logs,
      meta: paginate(total, page, limit),
    };
  }

  async getUserSessions(userId: string, query: any) {
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );

    const [sessions, total] = await Promise.all([
      this.prisma.user_sessions.findMany({
        where: { user_id: userId },
        skip,
        take,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.user_sessions.count({ where: { user_id: userId } }),
    ]);

    return {
      data: sessions.map((s) => ({
        id: s.id,
        device_name: s.device_name,
        device_os: s.device_os,
        ip_address: s.ip_address,
        user_agent: s.user_agent,
        is_revoked: s.is_revoked,
        used_at: s.used_at,
        created_at: s.created_at,
        expires_at: s.expires_at,
      })),
      meta: paginate(total, page, limit),
    };
  }

  async getAdminAuditLog(query: any) {
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const where: any = {};

    if (query.action) where.action = query.action;
    if (query.entity_type) where.entity_type = query.entity_type;
    if (query.user_id) where.user_id = query.user_id;

    if (query.start_date || query.end_date) {
      where.created_at = {};
      if (query.start_date) where.created_at.gte = new Date(query.start_date);
      if (query.end_date) where.created_at.lte = new Date(query.end_date);
    }

    const [logs, total] = await Promise.all([
      this.prisma.audit_logs.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
        include: { users: { select: { username: true, email: true } } },
      }),
      this.prisma.audit_logs.count({ where }),
    ]);

    return {
      data: logs,
      meta: paginate(total, page, limit),
    };
  }

  async getSecurityStats() {
    const [
      totalEvents,
      criticalEvents,
      highEvents,
      failedLogins,
      tokenThefts,
      suspendedAccounts,
    ] = await Promise.all([
      this.prisma.security_events.count(),
      this.prisma.security_events.count({ where: { severity: 'critical' } }),
      this.prisma.security_events.count({ where: { severity: 'high' } }),
      this.prisma.security_events.count({
        where: { event_type: 'FAILED_LOGIN' },
      }),
      this.prisma.security_events.count({
        where: { event_type: 'TOKEN_THEFT_DETECTED' },
      }),
      this.prisma.users.count({ where: { is_suspended: true } }),
    ]);

    return {
      data: {
        total_security_events: totalEvents,
        critical_events: criticalEvents,
        high_severity_events: highEvents,
        failed_login_attempts: failedLogins,
        token_theft_detections: tokenThefts,
        suspended_accounts: suspendedAccounts,
      },
    };
  }

  async listKycQueue(query: any) {
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const status = query.status ?? 'pending';
    const where = status === 'all' ? {} : { status };
    const [items, total] = await Promise.all([
      this.prisma.kyc_documents.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'asc' },
        select: {
          id: true,
          user_id: true,
          document_type: true,
          document_number: true,
          first_name: true,
          last_name: true,
          status: true,
          created_at: true,
          front_image: true,
          back_image: true,
          selfie_image: true,
          address_document: true,
          front_image_url: true,
          back_image_url: true,
          selfie_image_url: true,
          users_kyc_documents_user_idTousers: {
            select: { id: true, username: true, email: true, phone: true },
          },
        },
      }),
      this.prisma.kyc_documents.count({ where }),
    ]);
    return {
      data: items.map((d) => ({
        id: d.id,
        user_id: d.user_id,
        username: d.users_kyc_documents_user_idTousers?.username,
        email: d.users_kyc_documents_user_idTousers?.email,
        phone: d.users_kyc_documents_user_idTousers?.phone,
        first_name: d.first_name,
        last_name: d.last_name,
        document_type: d.document_type,
        document_number: d.document_number,
        status: d.status,
        created_at: d.created_at,
        front_image: d.front_image_url ?? d.front_image,
        back_image: d.back_image_url ?? d.back_image,
        selfie_image: d.selfie_image_url ?? d.selfie_image,
        address_document: d.address_document,
        front_image_url: d.front_image_url ?? d.front_image,
        back_image_url: d.back_image_url ?? d.back_image,
        selfie_image_url: d.selfie_image_url ?? d.selfie_image,
        address_document_url: d.address_document,
      })),
      meta: paginate(total, page, limit),
    };
  }

  async reviewKyc(
    kycDocId: string,
    adminId: string,
    dto: {
      status:
        | 'verified'
        | 'rejected'
        | 'under_review'
        | 'additional_info_required';
      rejection_reason?: string;
    },
  ) {
    const doc = await this.prisma.kyc_documents.findUnique({
      where: { id: kycDocId },
    });
    if (!doc) throw new NotFoundException('KYC document not found');
    if (doc.status !== 'pending')
      throw new BadRequestException('Document already reviewed');

    await this.prisma.kyc_documents.update({
      where: { id: kycDocId },
      data: {
        status: dto.status as any,
        reviewed_by: adminId,
        rejection_reason: dto.rejection_reason,
        reviewed_at: new Date(),
      },
    });

    const hasPersonal = Boolean(
      doc.first_name &&
      doc.last_name &&
      (doc.date_of_birth || doc.phone || doc.email),
    );
    const hasDocument = Boolean(
      doc.document_type &&
      (doc.document_number ||
        doc.front_image ||
        doc.back_image ||
        doc.selfie_image),
    );
    const hasAddress = Boolean(
      doc.country &&
      doc.county &&
      doc.city &&
      doc.physical_address &&
      doc.postal_code,
    );
    const kycLevel = !hasPersonal ? 0 : !hasDocument ? 1 : !hasAddress ? 2 : 3;

    // Update user's kyc_status based on approval
    await this.prisma.users.update({
      where: { id: doc.user_id! },
      data: { kyc_status: dto.status as any, kyc_level: kycLevel },
    });

    // Log the action
    await this.prisma.audit_logs.create({
      data: {
        user_id: adminId,
        action: `REVIEW_KYC_${dto.status.toUpperCase()}`,
        entity_type: 'kyc_documents',
        entity_id: kycDocId,
        new_values: dto as any,
      },
    });

    const notificationByStatus = {
      verified: {
        title: 'KYC Approved',
        body: 'Your KYC has been approved. You can now access verified-user features.',
      },
      rejected: {
        title: 'KYC Rejected',
        body: dto.rejection_reason
          ? `Your KYC was not approved. Please update and resubmit your details. Reason: ${dto.rejection_reason}`
          : 'Your KYC was not approved. Please update and resubmit your details.',
      },
      under_review: {
        title: 'KYC Under Review',
        body: 'Your KYC details are being reviewed by our team.',
      },
      additional_info_required: {
        title: 'Additional KYC Information Required',
        body: dto.rejection_reason
          ? `Please update and resubmit your KYC details. Reason: ${dto.rejection_reason}`
          : 'Please update and resubmit your KYC details.',
      },
    } as const;
    const notification = notificationByStatus[dto.status];
    await this.notifications
      .sendNotification(doc.user_id!, {
        type: 'kyc_update',
        entityId: kycDocId,
        title: notification.title,
        body: notification.body,
        metadata: {
          kyc_id: kycDocId,
          kyc_status: dto.status,
          reviewed_by: adminId,
          ...(dto.rejection_reason
            ? { rejection_reason: dto.rejection_reason }
            : {}),
        },
      })
      .catch((error) => console.error('KYC review notification failed', error));

    return { data: doc, message: 'KYC reviewed successfully' };
  }

  // ── Superadmin Management ────────────────────────────────────────────────────
  async createSuperadmin(dto: any, adminId: string) {
    const existing = await this.prisma.users.findFirst({
      where: {
        OR: [
          { phone: dto.phone },
          { username: dto.username.toLowerCase() },
          { email: dto.email },
        ],
      },
    });

    if (existing) {
      if (existing.phone === dto.phone)
        throw new BadRequestException('Phone already exists');
      if (existing.username === dto.username.toLowerCase())
        throw new BadRequestException('Username already taken');
      throw new BadRequestException('Email already exists');
    }

    const bcrypt = require('bcrypt');
    const password_hash = await bcrypt.hash(dto.password, 12);

    const {
      generateReferralCode,
      generateWalletAddress,
    } = require('../common/utils/reference.util');
    const user = await this.prisma.$transaction(async (tx: any) => {
      const u = await tx.users.create({
        data: {
          first_name: dto.first_name,
          last_name: dto.last_name,
          username: dto.username.toLowerCase(),
          phone: dto.phone,
          email: dto.email,
          password_hash,
          country: dto.country,
          role: 'super_admin',
          phone_verified: true,
          email_verified: true,
          is_active: true,
          is_suspended: false,
          is_deleted: false,
          referral_code: generateReferralCode(),
        },
      });

      await tx.wallets.create({
        data: {
          user_id: u.id,
          wallet_name: `${u.first_name}'s Wallet`,
          wallet_type: 'user',
          wallet_address: generateWalletAddress(
            u.id,
            process.env.QR_HMAC_SECRET || 'farm-secret',
          ),
          currency: 'FARM',
        },
      });

      await tx.audit_logs.create({
        data: {
          user_id: adminId,
          action: 'CREATE_SUPERADMIN',
          entity_type: 'users',
          entity_id: u.id,
          new_values: {
            first_name: u.first_name,
            last_name: u.last_name,
            username: u.username,
            role: 'super_admin',
          } as any,
        },
      });

      return u;
    });

    return {
      data: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        username: user.username,
        phone: user.phone,
        email: user.email,
        role: user.role,
      },
      message: 'Superadmin created successfully',
    };
  }

  async updateUser(userId: string, dto: any, adminId: string) {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user || user.is_deleted) throw new NotFoundException('User not found');
    // Staff accounts and staff roles are managed only via the SUPER_ADMIN
    // admin-management routes; the ordinary user editor must not touch them
    // (prevents changing a staff member's phone/email/role from here).
    const staffRoles = ['admin', 'super_admin'];
    if (
      staffRoles.includes(String(user.role ?? '').toLowerCase()) ||
      (dto.role !== undefined && staffRoles.includes(String(dto.role).toLowerCase()))
    ) {
      throw new ForbiddenException('Staff roles can only be managed by superadmins');
    }

    const updateData: any = {};
    if (dto.first_name) updateData.first_name = dto.first_name;
    if (dto.last_name) updateData.last_name = dto.last_name;
    if (dto.username) updateData.username = dto.username.toLowerCase();
    if (dto.phone) updateData.phone = dto.phone;
    if (dto.email) updateData.email = dto.email;
    if (dto.country) updateData.country = dto.country;
    if (dto.role) updateData.role = dto.role;
    if (dto.is_active !== undefined) updateData.is_active = dto.is_active;
    if (dto.is_suspended !== undefined)
      updateData.is_suspended = dto.is_suspended;

    const updated = await this.prisma.users.update({
      where: { id: userId },
      data: updateData,
    });
    await this.prisma.audit_logs.create({
      data: {
        user_id: adminId,
        action: 'UPDATE_USER',
        entity_type: 'users',
        entity_id: userId,
        new_values: updateData as any,
      },
    });
    return { data: updated, message: 'User updated successfully' };
  }

  async deleteUser(userId: string, adminId: string) {
    const user = await this.prisma.users.findUnique({ where: { id: userId } });
    if (!user || user.is_deleted) throw new NotFoundException('User not found');

    const deleted = await this.prisma.users.update({
      where: { id: userId },
      data: { is_deleted: true },
    });
    await this.prisma.audit_logs.create({
      data: {
        user_id: adminId,
        action: 'DELETE_USER',
        entity_type: 'users',
        entity_id: userId,
      },
    });
    return { data: deleted, message: 'User deleted successfully' };
  }

  async listSuperadmins(query: any) {
    const { skip, take } = paginationParams(query.page, query.limit);
    const where: any = { role: 'super_admin', is_deleted: false };

    if (query.search) {
      where.OR = [
        { username: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { first_name: { contains: query.search, mode: 'insensitive' } },
        { last_name: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.users.findMany({
        where,
        skip,
        take,
        select: {
          id: true,
          first_name: true,
          last_name: true,
          username: true,
          email: true,
          phone: true,
          role: true,
          is_active: true,
          created_at: true,
          updated_at: true,
        },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.users.count({ where }),
    ]);

    return { data, total, page: query.page ?? 1, limit: query.limit ?? 10 };
  }

  async getSuperadmin(id: string) {
    const user = await this.prisma.users.findUnique({
      where: { id },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        username: true,
        email: true,
        phone: true,
        country: true,
        role: true,
        is_active: true,
        phone_verified: true,
        email_verified: true,
        created_at: true,
        updated_at: true,
      },
    });

    if (!user || user.role !== 'super_admin')
      throw new NotFoundException('Superadmin not found');
    return { data: user };
  }

  async updateSuperadmin(id: string, dto: any, adminId: string) {
    const user = await this.prisma.users.findUnique({ where: { id } });
    if (!user || user.role !== 'super_admin')
      throw new NotFoundException('Superadmin not found');

    const updateData: any = {};
    if (dto.first_name) updateData.first_name = dto.first_name;
    if (dto.last_name) updateData.last_name = dto.last_name;
    if (dto.email) updateData.email = dto.email;
    if (dto.phone) updateData.phone = dto.phone;
    if (dto.country) updateData.country = dto.country;
    if (dto.is_active !== undefined) updateData.is_active = dto.is_active;

    const updated = await this.prisma.users.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        first_name: true,
        last_name: true,
        username: true,
        email: true,
        phone: true,
        role: true,
        is_active: true,
      },
    });

    await this.prisma.audit_logs.create({
      data: {
        user_id: adminId,
        action: 'UPDATE_SUPERADMIN',
        entity_type: 'users',
        entity_id: id,
        new_values: updateData as any,
      },
    });

    return { data: updated, message: 'Superadmin updated successfully' };
  }

  async deactivateSuperadmin(id: string, adminId: string) {
    const user = await this.prisma.users.findUnique({ where: { id } });
    if (!user || user.role !== 'super_admin')
      throw new NotFoundException('Superadmin not found');

    const updated = await this.prisma.users.update({
      where: { id },
      data: { is_active: false },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        username: true,
        role: true,
        is_active: true,
      },
    });

    await this.prisma.audit_logs.create({
      data: {
        user_id: adminId,
        action: 'DEACTIVATE_SUPERADMIN',
        entity_type: 'users',
        entity_id: id,
      },
    });

    return { data: updated, message: 'Superadmin deactivated successfully' };
  }

  async getSuperadminDashboard() {
    const [
      totalUsers,
      totalTransactions,
      totalRevenue,
      activeTransactions,
      flaggedTx,
      supportTickets,
      pendingDisputes,
      pendingKyc,
    ] = await Promise.all([
      this.prisma.users.count({
        where: {
          is_deleted: false,
          OR: [{ role: { notIn: ['admin', 'super_admin'] } }, { role: null }],
        },
      }),
      this.prisma.transactions.count({ where: { status: 'completed' } }),
      this.prisma.transactions.aggregate({
        where: { status: 'completed' },
        _sum: { amount: true },
      }),
      this.prisma.transactions.count({ where: { status: 'pending' } }),
      this.prisma.transactions.count({
        where: { status: { in: ['failed', 'cancelled', 'reversed'] } },
      }),
      this.prisma.support_tickets?.count?.({ where: { status: 'open' } }) ??
        Promise.resolve(0),
      this.prisma.escrow_contracts.count({ where: { status: 'disputed' } }),
      this.prisma.kyc_documents.count({ where: { status: 'pending' } }),
    ]);

    const recentTx = await this.prisma.transactions.findMany({
      take: 10,
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        transaction_type: true,
        amount: true,
        status: true,
        created_at: true,
      },
    });
    // Aggregate only completed transactions that actually contributed platform fees.
    const [
      escrowCreationAgg,
      escrowReleaseAgg,
      withdrawalAgg,
      merchantSalesAgg,
    ] = await Promise.all([
      this.prisma.transactions.aggregate({
        where: {
          transaction_type: 'escrow_lock',
          status: 'completed',
          fee: { gt: 0 },
        },
        _sum: { fee: true },
        _count: { id: true },
      }),
      this.prisma.transactions.aggregate({
        where: {
          transaction_type: 'escrow_release',
          status: 'completed',
          fee: { gt: 0 },
        },
        _sum: { fee: true },
        _count: { id: true },
      }),
      this.prisma.transactions.aggregate({
        where: {
          transaction_type: 'withdrawal',
          status: 'completed',
          fee: { gt: 0 },
        },
        _sum: { fee: true },
        _count: { id: true },
      }),
      this.prisma.transactions.aggregate({
        where: {
          transaction_type: 'merchant_payment',
          status: 'completed',
          fee: { gt: 0 },
          metadata: {
            path: ['platform_fee_type'],
            equals: 'merchant_sale',
          },
        },
        _sum: { fee: true },
        _count: { id: true },
      }),
    ]);

    const escrow_creation_earnings = Number(escrowCreationAgg._sum.fee ?? 0);
    const escrow_release_earnings = Number(escrowReleaseAgg._sum.fee ?? 0);
    const withdrawal_total_earnings = Number(withdrawalAgg._sum.fee ?? 0);
    const merchant_sales_fee_earnings = Number(merchantSalesAgg._sum.fee ?? 0);
    const escrow_total_earnings =
      escrow_creation_earnings + escrow_release_earnings;
    const total_platform_fee_earnings = Number(
      (
        escrow_total_earnings +
        withdrawal_total_earnings +
        merchant_sales_fee_earnings
      ).toFixed(2),
    );

    return {
      data: {
        total_users: totalUsers,
        total_revenue: total_platform_fee_earnings,
        total_transaction_volume: Number(totalRevenue._sum.amount ?? 0),
        active_transactions: activeTransactions,
        flagged_transactions: flaggedTx,
        support_tickets: supportTickets,
        pending_disputes: pendingDisputes,
        pending_kyc: pendingKyc,
        system_health: 99,
        recent_activities: recentTx.map((tx: any) => ({
          description: `${tx.transaction_type} transaction of $${tx.amount}`,
          type: tx.transaction_type,
          timestamp: tx.created_at,
        })),
        // Escrow revenue breakdown (amounts are in FARM)
        escrow_total_earnings,
        withdrawal_total_earnings,
        withdraw_fee_earnings: withdrawal_total_earnings,
        withdraw_transaction_count: withdrawalAgg._count.id ?? 0,
        platform_fee_total_earnings: total_platform_fee_earnings,
        escrow_creation_earnings,
        escrow_release_earnings,
        escrow_creation_count: escrowCreationAgg._count.id ?? 0,
        escrow_release_count: escrowReleaseAgg._count.id ?? 0,
        withdrawal_fee_count: withdrawalAgg._count.id ?? 0,
        merchant_sales_fee_earnings,
        merchant_sales_count: merchantSalesAgg._count.id ?? 0,
        total_escrow_count:
          (escrowCreationAgg._count.id ?? 0) +
          (escrowReleaseAgg._count.id ?? 0),
      },
    };
  }

  async getComplianceReport(query: any) {
    const startDate = query.start_date
      ? new Date(query.start_date)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = query.end_date ? new Date(query.end_date) : new Date();

    const [
      kycVerified,
      kycPending,
      kycRejected,
      transactionsCompleted,
      transactionsFailed,
      suspiciousActivities,
    ] = await Promise.all([
      this.prisma.users.count({
        where: { kyc_status: 'verified' },
      }),
      this.prisma.kyc_documents.count({
        where: {
          status: 'pending',
          created_at: { gte: startDate, lte: endDate },
        },
      }),
      this.prisma.kyc_documents.count({
        where: {
          status: 'rejected',
          created_at: { gte: startDate, lte: endDate },
        },
      }),
      this.prisma.transactions.count({
        where: {
          status: 'completed',
          created_at: { gte: startDate, lte: endDate },
        },
      }),
      this.prisma.transactions.count({
        where: {
          status: 'failed',
          created_at: { gte: startDate, lte: endDate },
        },
      }),
      this.prisma.security_events.count({
        where: {
          severity: 'high',
          created_at: { gte: startDate, lte: endDate },
        },
      }),
    ]);

    return {
      data: {
        period: { start_date: startDate, end_date: endDate },
        kyc_status: {
          verified: kycVerified,
          pending: kycPending,
          rejected: kycRejected,
        },
        transactions: {
          completed: transactionsCompleted,
          failed: transactionsFailed,
        },
        suspicious_activities: suspiciousActivities,
      },
    };
  }
  // -- Superadmin Wallet Management ---------------------------------------------
  async getSuperadminWallet(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      include: { wallets: { where: { is_active: true }, take: 1 } },
    });
    if (!user || user.role !== 'super_admin')
      throw new NotFoundException('Superadmin not found');

    const wallet = user.wallets[0];
    if (!wallet) throw new NotFoundException('Superadmin wallet not found');

    // Get pending withdrawals
    const pendingWithdrawals = await this.prisma.withdrawal.aggregate({
      where: { userId, status: 'PENDING' },
      _sum: { amount: true },
    });

    // Get total withdrawn
    const totalWithdrawn = await this.prisma.withdrawal.aggregate({
      where: { userId, status: 'COMPLETED' },
      _sum: { settlement: true },
    });

    const [creationFees, releaseFees, withdrawalFees, merchantSalesFees] =
      await Promise.all([
        this.prisma.transactions.aggregate({
          where: {
            transaction_type: 'escrow_lock',
            status: 'completed',
            fee: { gt: 0 },
          },
          _sum: { fee: true },
          _count: { id: true },
        }),
        this.prisma.transactions.aggregate({
          where: {
            transaction_type: 'escrow_release',
            status: 'completed',
            fee: { gt: 0 },
          },
          _sum: { fee: true },
          _count: { id: true },
        }),
        this.prisma.transactions.aggregate({
          where: {
            transaction_type: 'withdrawal',
            status: 'completed',
            fee: { gt: 0 },
          },
          _sum: { fee: true },
          _count: { id: true },
        }),
        this.prisma.transactions.aggregate({
          where: {
            transaction_type: 'merchant_payment',
            status: 'completed',
            fee: { gt: 0 },
            metadata: {
              path: ['platform_fee_type'],
              equals: 'merchant_sale',
            },
          },
          _sum: { fee: true },
          _count: { id: true },
        }),
      ]);

    const escrowCreationRevenue = Number(creationFees._sum.fee ?? 0);
    const escrowReleaseRevenue = Number(releaseFees._sum.fee ?? 0);
    const withdrawalRevenue = Number(withdrawalFees._sum.fee ?? 0);
    const merchantSalesRevenue = Number(merchantSalesFees._sum.fee ?? 0);
    const totalPlatformRevenue = Number(
      (
        escrowCreationRevenue +
        escrowReleaseRevenue +
        withdrawalRevenue +
        merchantSalesRevenue
      ).toFixed(8),
    );

    const availableBalance = Math.max(
      0,
      Number(wallet.balance ?? 0) - Number(wallet.locked_balance ?? 0),
    );

    return {
      data: {
        balance: Number(wallet.balance ?? 0),
        available_balance: availableBalance,
        locked_balance: Number(wallet.locked_balance ?? 0),
        pending_withdrawals: Number(pendingWithdrawals._sum.amount ?? 0),
        total_withdrawn: Number(totalWithdrawn._sum.settlement ?? 0),
        escrow_creation_revenue: escrowCreationRevenue,
        escrow_release_revenue: escrowReleaseRevenue,
        withdrawal_revenue: withdrawalRevenue,
        merchant_sales_revenue: merchantSalesRevenue,
        total_platform_revenue: totalPlatformRevenue,
        escrow_creation_count: creationFees._count.id ?? 0,
        escrow_release_count: releaseFees._count.id ?? 0,
        withdrawal_fee_count: withdrawalFees._count.id ?? 0,
        merchant_sales_count: merchantSalesFees._count.id ?? 0,
        currency: wallet.currency ?? 'FARM',
        wallet_address: wallet.wallet_address,
      },
    };
  }

  async superadminWithdraw(userId: string, dto: any) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      include: { wallets: { where: { is_active: true }, take: 1 } },
    });
    if (!user || user.role !== 'super_admin')
      throw new NotFoundException('Superadmin not found');

    const wallet = user.wallets[0];
    if (!wallet) throw new NotFoundException('Superadmin wallet not found');

    // Use the withdrawal service to process the withdrawal
    const result = await this.withdrawService.createWithdrawal(userId, {
      amount: dto.amount,
      method: dto.method,
      phoneNumber: dto.phoneNumber,
      accountName: dto.accountName,
      accountNumber: dto.accountNumber,
      bankName: dto.bankName,
      cryptoAddress: dto.cryptoAddress,
      network: dto.network,
      pin: dto.pin,
    });

    await this.prisma.audit_logs.create({
      data: {
        user_id: userId,
        action: 'SUPERADMIN_WITHDRAWAL',
        entity_type: 'withdrawal',
        entity_id: result.withdrawal.id,
        new_values: {
          amount: dto.amount,
          method: dto.method,
          reference: result.reference,
        } as any,
      },
    });

    return result;
  }

  async listAdmins(query: any) {
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const where: any = { role: 'admin', is_deleted: false };
    if (query.search) {
      where.OR = [
        { username: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
        { first_name: { contains: query.search, mode: 'insensitive' } },
        { last_name: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.users.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          first_name: true,
          last_name: true,
          username: true,
          email: true,
          phone: true,
          role: true,
          is_active: true,
          is_suspended: true,
          created_at: true,
          updated_at: true,
        },
      }),
      this.prisma.users.count({ where }),
    ]);
    return { data, meta: paginate(total, page, limit) };
  }

  async setAdminStatus(
    adminId: string,
    action: 'suspend' | 'approve',
    actorId: string,
  ) {
    const admin = await this.prisma.users.findFirst({
      where: { id: adminId, role: 'admin', is_deleted: false },
    });
    if (!admin) throw new NotFoundException('Admin not found');
    const suspended = action === 'suspend';
    const result = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.users.update({
        where: { id: adminId },
        data: {
          is_suspended: suspended,
          is_active: !suspended,
        },
      });
      if (suspended) {
        await tx.user_sessions.updateMany({
          where: {
            user_id: adminId,
            OR: [{ is_revoked: false }, { is_revoked: null }],
          },
          data: { is_revoked: true },
        });
      }
      await tx.audit_logs.create({
        data: {
          user_id: actorId,
          action: suspended ? 'SUSPEND_ADMIN' : 'APPROVE_ADMIN',
          entity_type: 'users',
          entity_id: adminId,
        },
      });
      return updated;
    });
    return {
      data: result,
      message: suspended
        ? 'Admin suspended successfully'
        : 'Admin approved successfully',
    };
  }

  async deleteAdmin(adminId: string, actorId: string) {
    const admin = await this.prisma.users.findFirst({
      where: { id: adminId, role: 'admin', is_deleted: false },
    });
    if (!admin) throw new NotFoundException('Admin not found');
    return this.prisma.$transaction(async (tx) => {
      const deleted = await tx.users.update({
        where: { id: adminId },
        data: {
          is_deleted: true,
          is_active: false,
          is_suspended: true,
          deleted_at: new Date(),
          first_name: 'Deleted',
          last_name: 'Admin',
          username: `deleted_${adminId}`,
          email: null,
          phone: `deleted_${adminId.slice(0, 12)}`,
          firebase_uid: null,
          password_hash: '!deleted!',
          profile_image: null,
          bio: null,
          country: null,
          city: null,
          address: null,
          referral_code: null,
          referred_by: null,
          pin_hash: null,
        },
      });
      await tx.user_sessions.updateMany({
        where: {
          user_id: adminId,
          OR: [{ is_revoked: false }, { is_revoked: null }],
        },
        data: { is_revoked: true, expires_at: new Date() },
      });
      await tx.device_tokens.deleteMany({ where: { user_id: adminId } });
      await tx.biometric_settings.deleteMany({ where: { user_id: adminId } });
      await tx.api_keys.deleteMany({ where: { user_id: adminId } });
      await tx.notifications.deleteMany({ where: { user_id: adminId } });
      await tx.audit_logs.create({
        data: {
          user_id: actorId,
          action: 'DELETE_ADMIN',
          entity_type: 'users',
          entity_id: adminId,
        },
      });
      return { data: deleted, message: 'Admin deleted successfully' };
    });
  }

  async getKycDocument(id: string) {
    const document = await this.prisma.kyc_documents.findUnique({
      where: { id },
    });
    if (!document) throw new NotFoundException('KYC document not found');
    return {
      data: {
        ...document,
        front_image: document.front_image_url ?? document.front_image,
        back_image: document.back_image_url ?? document.back_image,
        selfie_image: document.selfie_image_url ?? document.selfie_image,
        address_document: document.address_document,
        front_image_url: document.front_image_url ?? document.front_image,
        back_image_url: document.back_image_url ?? document.back_image,
        selfie_image_url: document.selfie_image_url ?? document.selfie_image,
        address_document_url: document.address_document ?? null,
      },
    };
  }
}
