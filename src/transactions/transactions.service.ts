import { cleanTransactionDescription } from '../common/utils/transaction-description';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CacheService } from '../common/cache/cache.service';
import { paginationParams, paginate } from '../common/utils/pagination.util';
import { HIDDEN_TRANSACTION_HISTORY_STATUSES } from '../common/utils/hidden-transaction-history-statuses';

export interface TransactionUserSummary {
  id: string;
  username: string;
  first_name?: string | null;
  last_name?: string | null;
  profile_image?: string | null;
}

@Injectable()
export class TransactionsService {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
  ) {}

  async findAll(userId: string, query: any) {
    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: userId },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const where: any = {
      AND: [
        {
          OR: [
            { sender_wallet_id: wallet.id },
            { receiver_wallet_id: wallet.id },
          ],
        },
        { status: { notIn: HIDDEN_TRANSACTION_HISTORY_STATUSES } },
      ],
    };
    if (query.type) where.AND.push({ transaction_type: query.type });
    if (query.status) where.AND.push({ status: query.status });
    const cacheKey =
      `transactions:${userId}:${page}:${limit}:user-history-v3:` +
      `${query.type ?? 'all'}:${query.status ?? 'all'}`;
    const cached = await this.cache.cacheGet<any>(cacheKey);
    if (cached) {
      return cached;
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
              id: true,
              user_id: true,
              users: {
                select: {
                  id: true,
                  username: true,
                  first_name: true,
                  last_name: true,
                  profile_image: true,
                },
              },
            },
          },
          wallets_transactions_receiver_wallet_idTowallets: {
            select: {
              id: true,
              user_id: true,
              users: {
                select: {
                  id: true,
                  username: true,
                  first_name: true,
                  last_name: true,
                  profile_image: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.transactions.count({ where }),
    ]);

    const merchantIds = [
      ...new Set(
        items
          .map((t: any) => {
            const metadata = t.metadata;
            if (metadata && typeof metadata === 'object') {
              return metadata.merchant_id || metadata.merchantId;
            }
            return null;
          })
          .filter((id: any) => id != null),
      ),
    ];

    const merchantMap: Record<string, string> = {};
    if (merchantIds.length > 0) {
      const merchants = await this.prisma.merchants.findMany({
        where: { id: { in: merchantIds } },
        select: { id: true, business_name: true },
      });
      merchants.forEach((m) => {
        if (m.id && m.business_name) merchantMap[m.id] = m.business_name;
      });
    }

    const payload = {
      data: items.map((t) => {
        const normalizedStatus = this.normalizeTransactionStatus(
          t.status,
          t.transaction_type,
        );
        const normalizedDescription = this.normalizeTransactionDescription(
          t.transaction_type,
          normalizedStatus,
          t.description,
        );

        const senderUser = this.buildUserSummary(
          t.wallets_transactions_sender_wallet_idTowallets?.users,
        );
        const recipientUser = this.buildUserSummary(
          t.wallets_transactions_receiver_wallet_idTowallets?.users,
        );

        let merchantBusinessName = '';
        if (t.metadata && typeof t.metadata === 'object') {
          const merchantId =
            (t.metadata as any).merchant_id || (t.metadata as any).merchantId;
          if (merchantId) merchantBusinessName = merchantMap[merchantId] || '';
        }

        return {
          ...t,
          status: normalizedStatus,
          description: normalizedDescription,
          amount: Number(t.amount),
          fee: Number(t.fee),
          net_amount: Number(t.net_amount),
          is_outgoing: t.sender_wallet_id === wallet.id,
          sender_username: senderUser?.username ?? '',
          recipient_username: recipientUser?.username ?? '',
          sender_user: senderUser,
          recipient_user: recipientUser,
          users_sender: senderUser,
          users_recipient: recipientUser,
          merchant_business_name: merchantBusinessName,
        };
      }),
      meta: paginate(total, page, limit),
    };
    await this.cache.cacheSet(cacheKey, payload, 45);
    return payload;
  }

  async findOne(userId: string, txId: string) {
    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: userId },
    });
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        txId,
      );
    const txn = await this.prisma.transactions.findFirst({
      where: {
        OR: [
          ...(isUuid ? [{ id: txId }] : []),
          { transaction_reference: txId },
        ],
        AND: [
          {
            OR: [
              { sender_wallet_id: wallet?.id },
              { receiver_wallet_id: wallet?.id },
            ],
          },
        ],
      },
      include: {
        ledger_entries: true,
        wallets_transactions_sender_wallet_idTowallets: {
          select: {
            id: true,
            user_id: true,
            users: {
              select: {
                id: true,
                username: true,
                first_name: true,
                last_name: true,
                profile_image: true,
              },
            },
          },
        },
        wallets_transactions_receiver_wallet_idTowallets: {
          select: {
            id: true,
            user_id: true,
            users: {
              select: {
                id: true,
                username: true,
                first_name: true,
                last_name: true,
                profile_image: true,
              },
            },
          },
        },
      },
    });
    if (!txn) throw new NotFoundException('Transaction not found');
    const normalizedStatus = this.normalizeTransactionStatus(
      txn.status,
      txn.transaction_type,
    );
    const senderUser = this.buildUserSummary(
      (txn as any).wallets_transactions_sender_wallet_idTowallets?.users,
    );
    const recipientUser = this.buildUserSummary(
      (txn as any).wallets_transactions_receiver_wallet_idTowallets?.users,
    );
    const metadata =
      txn.metadata && typeof txn.metadata === 'object'
        ? (txn.metadata as Record<string, any>)
        : {};
    const deposit =
      txn.transaction_type === 'deposit'
        ? await this.prisma.deposit.findFirst({
            where: { reference: txn.transaction_reference },
          })
        : null;
    const depositOwner =
      txn.transaction_type === 'deposit' && !recipientUser && wallet?.user_id
        ? await this.prisma.users.findUnique({
            where: { id: wallet.user_id },
            select: {
              id: true,
              username: true,
              first_name: true,
              last_name: true,
              profile_image: true,
            },
          })
        : null;
    const detailRecipientUser =
      recipientUser ?? this.buildUserSummary(depositOwner);
    const withdrawal =
      txn.transaction_type === 'withdrawal'
        ? await this.prisma.withdrawal.findUnique({
            where: { reference: txn.transaction_reference },
            select: {
              method: true,
              cryptoAsset: true,
              network: true,
              fee: true,
              settlement: true,
              status: true,
              rejectionReason: true,
            },
          })
        : null;
    const fiatAmount =
      metadata.amount_fiat ??
      metadata.amount_usd ??
      (deposit && deposit.currency !== txn.currency ? deposit.amount : null);
    const fiatCurrency =
      metadata.currency_fiat ??
      (metadata.amount_usd != null
        ? 'USD'
        : deposit && deposit.currency !== txn.currency
          ? deposit.currency
          : null);
    const displayName = (user: TransactionUserSummary | null) =>
      user
        ? [user.first_name, user.last_name]
            .filter((part): part is string => Boolean(part?.trim()))
            .join(' ') || user.username
        : '';
    const provider = (metadata.provider ?? deposit?.provider ?? '')
      .toString()
      .trim();
    const providerLabel = provider
      ? provider.toLowerCase() === 'ivorypay'
        ? 'IvoryPay'
        : provider.charAt(0).toUpperCase() + provider.slice(1)
      : '';
    const externalSenderName = [
      metadata.sender_name,
      metadata.payer_name,
      metadata.customer_name,
    ].find((name) => typeof name === 'string' && name.trim());

    let merchantBusinessName = '';
    if (txn.metadata && typeof txn.metadata === 'object') {
      const merchantId =
        (txn.metadata as any).merchant_id || (txn.metadata as any).merchantId;
      if (merchantId) {
        const merchant = await this.prisma.merchants.findUnique({
          where: { id: merchantId },
          select: { business_name: true },
        });
        merchantBusinessName = merchant?.business_name || '';
      }
    }

    return {
      data: {
        ...txn,
        status: normalizedStatus,
        description: this.normalizeTransactionDescription(
          txn.transaction_type,
          normalizedStatus,
          txn.description,
        ),
        original_description: txn.description,
        amount: Number(txn.amount),
        fee: Number(withdrawal?.fee ?? txn.fee),
        net_amount: Number(withdrawal?.settlement ?? txn.net_amount),
        amount_farm:
          metadata.amount_farm ??
          (txn.currency === 'FARM' ? Number(txn.amount) : null),
        fiat_amount: fiatAmount == null ? null : Number(fiatAmount),
        fiat_currency: fiatCurrency,
        payment_method:
          metadata.payment_method ??
          metadata.method ??
          deposit?.paymentMethod ??
          null,
        payment_provider: metadata.provider ?? deposit?.provider ?? null,
        provider_reference:
          metadata.provider_ref ??
          deposit?.providerRef ??
          deposit?.providerReference ??
          null,
        provider_transaction_id: deposit?.providerTransactionId ?? null,
        payment_reference: deposit?.paymentReference ?? null,
        merchant_reference: deposit?.merchantReference ?? null,
        checkout_id: deposit?.checkoutId ?? null,
        blockchain_tx_hash:
          txn.blockchain_tx_hash ?? deposit?.blockchainTransactionHash ?? null,
        deposit_status: deposit?.status ?? null,
        deposit_verified_at: deposit?.verifiedAt ?? null,
        deposit_credited_at: deposit?.creditedAt ?? null,
        deposit_webhook_received_at: deposit?.webhookReceived ?? null,
        deposit_verification_attempts: deposit?.verificationAttempts ?? null,
        withdrawal_status: withdrawal?.status ?? null,
        withdrawal_method: withdrawal?.method ?? null,
        withdrawal_network: withdrawal?.network ?? null,
        crypto_asset: withdrawal?.cryptoAsset ?? null,
        settlement_amount: withdrawal?.settlement ?? null,
        failure_reason: withdrawal?.rejectionReason ?? null,
        is_outgoing: txn.sender_wallet_id === wallet?.id,
        sender_username: senderUser?.username ?? '',
        recipient_username: detailRecipientUser?.username ?? '',
        sender_name:
          displayName(senderUser) ||
          (txn.transaction_type === 'deposit'
            ? (externalSenderName ?? providerLabel) || 'External payment'
            : ''),
        receiver_name: displayName(detailRecipientUser),
        sender_user: senderUser,
        recipient_user: detailRecipientUser,
        users_sender: senderUser,
        users_recipient: detailRecipientUser,
        merchant_business_name: merchantBusinessName,
      },
    };
  }

  private buildUserSummary(user: any): TransactionUserSummary | null {
    if (!user) return null;
    return {
      id: user.id,
      username: user.username ?? '',
      first_name: user.first_name ?? null,
      last_name: user.last_name ?? null,
      profile_image: user.profile_image ?? null,
    };
  }

  private normalizeTransactionStatus(
    status: string | null | undefined,
    transactionType?: string | null,
  ) {
    const normalized = (status ?? '').toString().toLowerCase();
    const successfulStatuses = [
      'completed',
      'success',
      'successful',
      'succeeded',
      'paid',
      'settled',
    ];
    const pendingStatuses = [
      'pending',
      'processing',
      'initiated',
      'in_progress',
    ];
    const failedStatuses = [
      'failed',
      'cancelled',
      'reversed',
      'declined',
      'expired',
      'abandoned',
      'incomplete',
    ];

    if (successfulStatuses.includes(normalized)) return 'Completed';
    if (pendingStatuses.includes(normalized)) return 'Pending';
    if (failedStatuses.includes(normalized)) return 'Failed';

    if (
      transactionType?.toLowerCase() === 'deposit' &&
      normalized.includes('success')
    )
      return 'Completed';
    if (
      transactionType?.toLowerCase() === 'withdrawal' &&
      normalized.includes('success')
    )
      return 'Completed';
    return status?.toString() ?? 'Pending';
  }

  private normalizeTransactionDescription(
    transactionType: string | null | undefined,
    _status: string | null | undefined,
    description: string | null | undefined,
  ) {
    // Status is shown by its own badge; the description must not repeat it.
    const cleaned = cleanTransactionDescription(description);
    if (cleaned) return cleaned;
    const normalizedType = (transactionType ?? '').toString().toLowerCase();
    if (normalizedType === 'deposit') return 'Deposit';
    if (normalizedType === 'withdrawal') return 'Withdrawal';
    return 'Transaction';
  }
}
