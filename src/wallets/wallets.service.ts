import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { AuthService } from '../auth/auth.service';
import { SecurityService } from '../security/security.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CacheService } from '../common/cache/cache.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { generateTxReference } from '../common/utils/reference.util';
import { paginationParams, paginate } from '../common/utils/pagination.util';
import { HIDDEN_TRANSACTION_HISTORY_STATUSES } from '../common/utils/hidden-transaction-history-statuses';

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
    private securityService: SecurityService,
    private notificationsService: NotificationsService,
    private cache: CacheService,
    private websocket: WebsocketGateway,
  ) {}

  async getMyWallet(userId: string) {
    const cacheKey = `wallet:${userId}:balance`;
    const cached = await this.cache.cacheGet<any>(cacheKey);
    if (cached) {
      return cached;
    }

    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: userId, is_active: true },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');
    const available = Number(wallet.balance) - Number(wallet.locked_balance);
    const payload = {
      data: {
        id: wallet.id,
        wallet_address: wallet.wallet_address,
        wallet_type: wallet.wallet_type,
        balance: Number(wallet.balance),
        locked_balance: Number(wallet.locked_balance),
        available_balance: Math.max(0, available),
        currency: wallet.currency,
        blockchain_address: wallet.blockchain_address,
        is_frozen: wallet.is_frozen,
      },
    };

    await this.cache.cacheSet(cacheKey, payload, 30);
    return payload;
  }

  async sendFunds(
    senderId: string,
    dto: { recipient_identifier: string; amount: number; pin?: string; description?: string; biometric_auth?: boolean; device_fingerprint?: string },
    ip: string,
  ) {
    if (dto.amount <= 0) throw new BadRequestException('Amount must be greater than zero');
    // Support biometric-authenticated transactions: when `biometric_auth` is true,
    // verify the device fingerprint server-side via SecurityService and skip PIN verification.
    if (dto.biometric_auth) {
      const deviceFingerprint = dto.device_fingerprint || (dto as any).deviceFingerprint;
      if (!deviceFingerprint) {
        throw new BadRequestException('Device fingerprint required for biometric authorization');
      }
      const verified = await this.securityService.verifyDevice(senderId, deviceFingerprint);
      if (!verified || !('trusted' in verified) || (verified as any).trusted !== true) {
        throw new ForbiddenException('Biometric device verification failed');
      }
    } else {
      if (!dto.pin) throw new BadRequestException('Transaction PIN is required');
      await this.authService.verifyPin(senderId, dto.pin);
    }

    const receiverUser = await this.prisma.users.findFirst({
      where: {
        OR: [{ username: dto.recipient_identifier }, { phone: dto.recipient_identifier }],
        is_deleted: false,
        is_active: true,
      },
      include: { wallets: { where: { is_active: true }, take: 1 } },
    });

    let receiverUserId = receiverUser?.id;
    let receiverWalletId: string;
    if (receiverUser?.wallets[0]) {
      receiverWalletId = receiverUser.wallets[0].id;
    } else {
      const byAddress = await this.prisma.wallets.findUnique({
        where: { wallet_address: dto.recipient_identifier },
      });
      if (!byAddress) throw new NotFoundException('Recipient not found');
      receiverWalletId = byAddress.id;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const senderWallet = await tx.wallets.findFirst({
        where: { user_id: senderId, is_active: true },
      });
      if (!senderWallet) throw new NotFoundException('Sender wallet not found');
      if (senderWallet.is_frozen) throw new ForbiddenException('Your wallet is frozen. Contact support.');

      // Single transfer ceiling
      const MAX_SINGLE_TX = 100_000; // FARM
      if (dto.amount > MAX_SINGLE_TX) {
        throw new BadRequestException(`Single transfer limit is ${MAX_SINGLE_TX} FARM`);
      }

      // Daily velocity check
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const dailyVolume = await tx.transactions.aggregate({
        where: {
          sender_wallet_id: senderWallet.id,
          transaction_type: 'transfer',
          status: 'completed',
          created_at: { gte: todayStart },
        },
        _sum: { amount: true },
      });

      const MAX_DAILY = 500_000; // FARM
      const sentToday = Number(dailyVolume._sum.amount ?? 0);
      if (sentToday + dto.amount > MAX_DAILY) {
        throw new BadRequestException('Daily transfer limit exceeded');
      }

      if (senderWallet.id === receiverWalletId) {
        throw new BadRequestException('Cannot send to yourself');
      }

      const feeCfg = await tx.fee_configurations.findFirst({
        where: { transaction_type: 'transfer', is_active: true },
      });
      const pctFee = feeCfg ? Number(feeCfg.percentage_fee) / 100 : 0;
      const flatFee = feeCfg ? Number(feeCfg.flat_fee) : 0;
      let fee = dto.amount * pctFee + flatFee;
      if (feeCfg)
        fee = Math.max(
          Number(feeCfg.minimum_fee),
          Math.min(Number(feeCfg.maximum_fee ?? 999999), fee),
        );
      const totalOut = dto.amount + fee;

      const available = Number(senderWallet.balance) - Number(senderWallet.locked_balance);
      if (available < totalOut) {
        throw new BadRequestException(`Insufficient balance. Available: ${available.toFixed(2)} FARM`);
      }

      const cooldownWindow = new Date(Date.now() - 60_000);
      const recentDuplicate = await tx.transactions.findFirst({
        where: {
          sender_wallet_id: senderWallet.id,
          transaction_type: 'transfer',
          amount: dto.amount,
          status: 'completed',
          created_at: { gte: cooldownWindow },
        },
        orderBy: { created_at: 'desc' },
      });

      if (recentDuplicate) {
        throw new BadRequestException('You can only resend the same amount after 1 minute.');
      }

      const reference = generateTxReference();
      const transaction = await tx.transactions.create({
        data: {
          transaction_reference: reference,
          sender_wallet_id: senderWallet.id,
          receiver_wallet_id: receiverWalletId,
          transaction_type: 'transfer',
          status: 'processing',
          amount: dto.amount,
          fee,
          net_amount: dto.amount - fee,
          currency: 'FARM',
          description: dto.description || `Transfer to ${dto.recipient_identifier}`,
          ip_address: ip,
          metadata: { user_id: senderId },
        },
      });

      const recvWallet = await tx.wallets.findUnique({ where: { id: receiverWalletId } });
      if (!recvWallet) throw new NotFoundException('Recipient wallet not found');

      const updatedSenderWallet = await tx.wallets.update({
        where: { id: senderWallet.id },
        data: { balance: { decrement: totalOut } },
      });
      const updatedReceiverWallet = await tx.wallets.update({
        where: { id: receiverWalletId },
        data: { balance: { increment: dto.amount } },
      });
      receiverUserId = receiverUserId ?? recvWallet.user_id ?? undefined;

      await tx.ledger_entries.createMany({
        data: [
          {
            transaction_id: transaction.id,
            wallet_id: senderWallet.id,
            entry_type: 'debit',
            amount: totalOut,
            balance_before: Number(senderWallet.balance),
            balance_after: Number(senderWallet.balance) - totalOut,
            description: `Transfer to ${dto.recipient_identifier}`,
          },
          {
            transaction_id: transaction.id,
            wallet_id: receiverWalletId,
            entry_type: 'credit',
            amount: dto.amount,
            balance_before: Number(recvWallet.balance),
            balance_after: Number(recvWallet.balance) + dto.amount,
            description: 'Transfer received',
          },
        ],
      });

      await tx.transactions.update({
        where: { id: transaction.id },
        data: { status: 'completed', processed_at: new Date() },
      });

      return {
        data: { transaction_reference: reference, amount: dto.amount, fee, status: 'completed' },
        message: 'Transfer successful',
        senderBalance: Number(updatedSenderWallet.balance),
        receiverBalance: Number(updatedReceiverWallet.balance),
      };
    });

    try {
      this.websocket.emitBalanceUpdate(senderId, result.senderBalance);
      this.websocket.emitTransactionUpdate(senderId, {
        reference: result.data.transaction_reference,
        status: 'SUCCESS',
      });
      if (receiverUserId) {
        this.websocket.emitBalanceUpdate(receiverUserId, result.receiverBalance);
        this.websocket.emitTransactionUpdate(receiverUserId, {
          reference: result.data.transaction_reference,
          status: 'SUCCESS',
        });
      }
    } catch (error) {
      this.logger.warn(`Transfer realtime update failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (receiverUserId) {
      this.notificationsService
        .notifyTransfer(senderId, receiverUserId, dto.amount, result.data.transaction_reference)
        .catch((error) => this.logger.error('Transfer notification failed', error));
    }

    await Promise.all([
      this.cache.cacheDelete(`wallet:${senderId}:balance`),
      ...(receiverUserId ? [this.cache.cacheDelete(`wallet:${receiverUserId}:balance`)] : []),
      this.cache.cacheDelete(`dashboard:${senderId}`),
      ...(receiverUserId ? [this.cache.cacheDelete(`dashboard:${receiverUserId}`)] : []),
      this.cache.cacheInvalidatePattern(`transactions:${senderId}:*`),
      ...(receiverUserId ? [this.cache.cacheInvalidatePattern(`transactions:${receiverUserId}:*`)] : []),
    ]);

    return { data: result.data, message: result.message };
  }

  async getTransactions(userId: string, query: any) {
    const { skip, take, page, limit } = paginationParams(query.page, query.limit);
    const wallet = await this.prisma.wallets.findFirst({ where: { user_id: userId } });
    if (!wallet) throw new NotFoundException('Wallet not found');

    // Unsuccessful/in-flight transactions stay hidden from user history
    // (asserted by wallets.service.spec.ts on main).
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

    const cacheKey = `transactions:${userId}:${page}:${limit}:${query.type ?? ''}:${query.status ?? ''}`;
    const cached = await this.cache.cacheGet<any>(cacheKey);
    if (cached) {
      return cached;
    }

    const [txns, total] = await Promise.all([
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
    const payload = {
      data: txns.map((t) => {
        const senderUser = this.buildUserSummary(
          t.wallets_transactions_sender_wallet_idTowallets?.users,
        );
        const recipientUser = this.buildUserSummary(
          t.wallets_transactions_receiver_wallet_idTowallets?.users,
        );

        return {
          ...t,
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
        };
      }),
      meta: paginate(total, page, limit),
    };

    await this.cache.cacheSet(cacheKey, payload, 45);
    return payload;
  }

  private buildUserSummary(user: any) {
    if (!user) return null;
    return {
      id: user.id,
      username: user.username ?? '',
      first_name: user.first_name ?? null,
      last_name: user.last_name ?? null,
      profile_image: user.profile_image ?? null,
    };
  }
}