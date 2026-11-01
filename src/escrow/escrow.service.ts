import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
  Optional,
} from '@nestjs/common';
import { FeesService } from '../fees/fees.service';
import { computeFee, feeFor, ruleFor } from '../fees/fee-defaults';
import { PrismaService } from '../database/prisma.service';
import { AuthService } from '../auth/auth.service';
import { SecurityService } from '../security/security.service';
import { PaystackService } from '../paystack/paystack.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  generateEscrowReference,
  generateTxReference,
} from '../common/utils/reference.util';
import { paginationParams, paginate } from '../common/utils/pagination.util';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { CloudinaryService } from '../common/cloudinary.service';

/** Amount still locked in an escrow after milestone releases. */
export function remainingAmount(e: { amount: any; released_amount?: any }) {
  const left = Number(e.amount) - Number(e.released_amount ?? 0);
  return left > 0 ? Number(left.toFixed(8)) : 0;
}

@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);

  constructor(
    private prisma: PrismaService,
    private authService: AuthService,
    private paystack: PaystackService,
    private notificationsService: NotificationsService,
    private securityService: SecurityService,
    private websocket: WebsocketGateway,
    private cloudinaryService?: CloudinaryService,
    @Optional() private fees?: FeesService,
  ) {}

  private async getSuperadminWallet() {
    const superadmin = await this.prisma.users.findFirst({
      where: { role: 'super_admin', is_deleted: false },
      include: { wallets: { where: { is_active: true }, take: 1 } },
    });
    if (!superadmin?.wallets[0]) {
      throw new NotFoundException('Superadmin wallet not found');
    }
    return superadmin.wallets[0];
  }

  private async getSuperadminWalletInTx(tx: any) {
    const superadmin = await tx.users.findFirst({
      where: { role: 'super_admin', is_deleted: false },
      include: { wallets: { where: { is_active: true }, take: 1 } },
    });
    if (!superadmin?.wallets[0]) {
      throw new NotFoundException('Superadmin wallet not found');
    }
    return superadmin.wallets[0];
  }

  private async creditSuperadminWalletInTx(
    tx: any,
    amount: number,
    description: string,
  ) {
    if (amount <= 0) return;

    const wallet = await this.getSuperadminWalletInTx(tx);
    await tx.wallets.update({
      where: { id: wallet.id },
      data: { balance: { increment: amount } },
    });

    await tx.ledger_entries.create({
      data: {
        wallet_id: wallet.id,
        entry_type: 'credit',
        amount,
        description,
      },
    });
  }

  async create(
    buyerId: string,
    dto: {
      seller_identifier: string;
      amount: number;
      title: string;
      description?: string;
      auto_release_days?: number;
      pin?: string;
      biometric_auth?: boolean;
      device_fingerprint?: string;
    },
    /** Internal only (never from request bodies): settle to a business wallet. */
    opts?: { sellerWalletId?: string },
  ) {
    if (!Number.isFinite(dto.amount) || dto.amount <= 0) {
      throw new BadRequestException('Amount must be a positive number');
    }
    const sellerIdentifier = dto.seller_identifier?.trim();
    const title = dto.title?.trim();
    if (!sellerIdentifier)
      throw new BadRequestException(
        'Seller username or phone number is required',
      );
    if (!title) throw new BadRequestException('Escrow title is required');
    if (title.length > 255)
      throw new BadRequestException(
        'Escrow title must be 255 characters or fewer',
      );
    if (
      dto.auto_release_days != null &&
      (dto.auto_release_days < 1 || dto.auto_release_days > 90)
    ) {
      throw new BadRequestException(
        'Auto-release must be between 1 and 90 days',
      );
    }

    if (dto.biometric_auth) {
      if (!dto.device_fingerprint)
        throw new BadRequestException(
          'Device fingerprint required for biometric authorization',
        );
      const verified = await this.securityService.verifyDevice(
        buyerId,
        dto.device_fingerprint,
      );
      if (!verified || (verified as any).trusted !== true) {
        throw new BadRequestException('Biometric device verification failed');
      }
    } else {
      if (!dto.pin)
        throw new BadRequestException('Transaction PIN is required');
      await this.authService.verifyPin(buyerId, dto.pin);
    }

    const buyer = await this.prisma.users.findUnique({
      where: { id: buyerId },
      include: { wallets: { where: { is_active: true }, take: 1 } },
    });
    if (!buyer?.wallets[0])
      throw new NotFoundException('Buyer wallet not found');
    if (buyer.wallets[0].is_frozen) {
      throw new BadRequestException(
        'Buyer wallet is frozen and cannot fund an escrow',
      );
    }

    const seller = await this.prisma.users.findFirst({
      where: {
        OR: [{ username: sellerIdentifier }, { phone: sellerIdentifier }],
        is_deleted: false,
      },
      include: { wallets: { where: { is_active: true }, take: 1 } },
    });
    if (!seller?.wallets[0]) throw new NotFoundException('Seller not found');
    if (seller.id === buyerId)
      throw new BadRequestException('Cannot create escrow with yourself');

    const oneMinuteAgo = new Date(Date.now() - 60_000);
    const recentDuplicate = await this.prisma.escrow_contracts.findFirst({
      where: {
        buyer_id: buyerId,
        seller_id: seller.id,
        amount: dto.amount,
        created_at: { gte: oneMinuteAgo },
      },
    });
    if (recentDuplicate) {
      throw new BadRequestException(
        'You can only create one escrow with the same seller and amount once every minute',
      );
    }

    const fee = await feeFor(this.fees, 'escrow_creation', dto.amount); // half of the 3% escrow fee (see FEES.md)
    const totalRequired = dto.amount + fee;
    const available =
      Number(buyer.wallets[0].balance) -
      Number(buyer.wallets[0].locked_balance);
    if (available < totalRequired)
      throw new BadRequestException(
        `Insufficient balance. Need ${totalRequired} FARM`,
      );

    const auto_release_at = new Date(
      Date.now() + (dto.auto_release_days || 7) * 86400_000,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const lockedWallets = await tx.$queryRaw<
        Array<{ balance: unknown; locked_balance: unknown }>
      >`SELECT balance, locked_balance FROM wallets WHERE id = ${buyer.wallets[0].id}::uuid FOR UPDATE`;
      const lockedWallet = lockedWallets[0];
      if (!lockedWallet) throw new NotFoundException('Buyer wallet not found');

      const currentAvailable =
        Number(lockedWallet.balance ?? 0) -
        Number(lockedWallet.locked_balance ?? 0);
      if (currentAvailable < totalRequired) {
        throw new BadRequestException(
          `Insufficient balance. Need ${totalRequired} FARM`,
        );
      }

      const c = await tx.escrow_contracts.create({
        data: {
          reference_code: generateEscrowReference(),
          buyer_id: buyerId,
          seller_id: seller.id,
          buyer_wallet_id: buyer.wallets[0].id,
          seller_wallet_id: opts?.sellerWalletId ?? seller.wallets[0].id,
          amount: dto.amount,
          fee,
          title,
          description: dto.description,
          auto_release_at,
          status: 'pending',
        },
      });
      const updatedBuyerWallet = await tx.wallets.update({
        where: { id: buyer.wallets[0].id },
        data: {
          balance: { decrement: fee },
          locked_balance: { increment: dto.amount },
        },
      });
      const activeContract = await tx.escrow_contracts.update({
        where: { id: c.id },
        data: { status: 'active', funded_at: new Date() },
      });
      const transaction = await tx.transactions.create({
        data: {
          transaction_reference: generateTxReference(),
          sender_wallet_id: buyer.wallets[0].id,
          transaction_type: 'escrow_lock',
          status: 'completed',
          amount: dto.amount,
          fee,
          net_amount: dto.amount,
          description: `Escrow lock: ${title}`,
          metadata: { user_id: buyerId, escrow_id: c.id },
          processed_at: new Date(),
        },
      });
      // Credit escrow fee to superadmin wallet
      if (Number(fee) > 0) {
        await this.creditSuperadminWalletInTx(
          tx,
          Number(fee),
          `Escrow creation fee from ${buyer.username}: ${title}`,
        );
      }
      return {
        contract: activeContract,
        balance: Number(updatedBuyerWallet.balance),
        transactionReference: transaction.transaction_reference,
      };
    });
    const contract = result.contract;

    try {
      this.websocket.emitBalanceUpdate(buyerId, result.balance);
      this.websocket.emitTransactionUpdate(buyerId, {
        reference: result.transactionReference,
        status: 'SUCCESS',
      });
    } catch (error) {
      this.logger.warn(
        `Escrow creation realtime update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await Promise.all([
      this.notificationsService.sendNotification(buyerId, {
        type: 'escrow_created',
        title: 'Escrow created',
        body: `Your escrow for ${seller.username} has been funded with ${dto.amount} FARM.`,
        entityId: contract.id,
        metadata: {
          escrow_id: contract.id,
          amount: dto.amount,
          seller_username: seller.username,
          event: 'escrow_created',
          transaction_reference: result.transactionReference,
          transaction_type: 'escrow_lock',
        },
      }),
      this.notificationsService.sendNotification(seller.id, {
        type: 'escrow_received',
        title: 'New escrow received',
        body: `${buyer.username} funded an escrow for ${dto.amount} FARM.`,
        entityId: contract.id,
        metadata: {
          escrow_id: contract.id,
          amount: dto.amount,
          buyer_username: buyer.username,
          event: 'escrow_received',
          transaction_reference: result.transactionReference,
          transaction_type: 'escrow_lock',
        },
      }),
    ]).catch((error) => this.logger.error('Escrow notification failed', error));

    return {
      data: {
        ...contract,
        amount: Number(contract.amount),
        fee: Number(contract.fee),
      },
      message: 'Escrow created and funded',
    };
  }

  async release(
    escrowId: string,
    buyerId: string,
    dto?: {
      pin?: string;
      biometric_auth?: boolean;
      device_fingerprint?: string;
    },
  ) {
    const escrow = await this.getEscrowOrFail(escrowId);
    if (escrow.buyer_id !== buyerId)
      throw new ForbiddenException('Only the buyer can release');
    if (escrow.status === 'completed') {
      return { message: 'Escrow has already been released' };
    }
    if (escrow.status !== 'active') {
      throw new BadRequestException(
        `Cannot release escrow with status: ${escrow.status}`,
      );
    }

    if (dto?.biometric_auth) {
      if (!dto.device_fingerprint)
        throw new BadRequestException(
          'Device fingerprint required for biometric authorization',
        );
      const verified = await this.securityService.verifyDevice(
        buyerId,
        dto.device_fingerprint,
      );
      if (!verified || (verified as any).trusted !== true) {
        throw new BadRequestException('Biometric device verification failed');
      }
    } else {
      if (!dto?.pin)
        throw new BadRequestException('Transaction PIN is required');
      await this.authService.verifyPin(buyerId, dto.pin);
    }

    try {
      await this.executeRelease(escrow);
    } catch (error) {
      if (error instanceof BadRequestException) {
        const latestEscrow = await this.getEscrowOrFail(escrowId);
        if (
          latestEscrow.buyer_id === buyerId &&
          latestEscrow.status === 'completed'
        ) {
          return { message: 'Escrow has already been released' };
        }
      }
      throw error;
    }
    return { message: 'Escrow released to seller' };
  }

  async dispute(
    escrowId: string,
    userId: string,
    dto: {
      reason: string;
      attachmentBase64?: string;
      attachmentMimeType?: string;
      attachmentUrl?: string;
    },
  ) {
    const reason = dto.reason?.trim();
    if (!reason) throw new BadRequestException('Dispute reason is required');
    if (reason.length > 2000) {
      throw new BadRequestException(
        'Dispute reason must be 2000 characters or fewer',
      );
    }
    if (
      dto.attachmentUrl
        ? Boolean(dto.attachmentBase64)
        : Boolean(dto.attachmentBase64) !== Boolean(dto.attachmentMimeType)
    ) {
      throw new BadRequestException(
        'Provide either uploaded image URL or attachment data with its media type',
      );
    }
    if (dto.attachmentUrl) {
      let attachmentUrl: URL;
      try {
        attachmentUrl = new URL(dto.attachmentUrl);
      } catch {
        throw new BadRequestException('Uploaded image URL is invalid');
      }
      if (
        !dto.attachmentMimeType ||
        !['image/jpeg', 'image/png', 'image/webp'].includes(
          dto.attachmentMimeType,
        ) ||
        attachmentUrl.protocol !== 'https:' ||
        attachmentUrl.hostname !== 'res.cloudinary.com' ||
        !attachmentUrl.pathname.includes('/image/upload/')
      ) {
        throw new BadRequestException('Uploaded image URL is invalid');
      }
    }

    const escrow = await this.getEscrowOrFail(escrowId);
    if (escrow.buyer_id !== userId && escrow.seller_id !== userId)
      throw new ForbiddenException('Not a party to this escrow');
    if (escrow.status !== 'active')
      throw new BadRequestException('Can only dispute an active escrow');
    const attachmentUrl =
      dto.attachmentUrl ??
      (dto.attachmentBase64
        ? await this.uploadDisputeAttachment(
            escrowId,
            dto.attachmentMimeType!,
            dto.attachmentBase64,
          )
        : null);
    const otherPartyId =
      escrow.buyer_id === userId ? escrow.seller_id : escrow.buyer_id;
    if (!otherPartyId)
      throw new BadRequestException('Escrow has no other party');

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.escrow_contracts.updateMany({
        where: { id: escrowId, status: 'active' },
        data: {
          status: 'disputed',
          disputed_at: new Date(),
          evidence: {
            reason,
            disputed_by: userId,
            ...(attachmentUrl
              ? {
                  attachment_url: attachmentUrl,
                  attachment_mime_type: dto.attachmentMimeType,
                }
              : {}),
          },
        },
      });
      if (updated.count !== 1) {
        throw new BadRequestException('Can only dispute an active escrow');
      }
      await tx.escrow_messages.create({
        data: {
          escrow_id: escrowId,
          sender_id: userId,
          message: `DISPUTE RAISED: ${reason}`,
          ...(attachmentUrl ? { attachment_url: attachmentUrl } : {}),
        },
      });
    });

    await Promise.all([
      this.notificationsService.sendNotification(userId, {
        type: 'escrow_disputed',
        entityId: escrow.id,
        title: 'Dispute Raised',
        body: `You have raised a dispute for escrow: ${escrow.title}. Our admin team will review within 24 hours.`,
        metadata: {
          escrow_id: escrow.id,
          reason,
          amount: Number(escrow.amount),
          event: 'escrow_disputed',
        },
      }),
      this.notificationsService.sendNotification(otherPartyId, {
        type: 'escrow_disputed',
        entityId: escrow.id,
        title: 'Escrow Under Dispute',
        body: `A dispute has been raised for escrow: ${escrow.title}. Our admin team will investigate.`,
        metadata: {
          escrow_id: escrow.id,
          disputed_by: userId,
          reason,
          amount: Number(escrow.amount),
          event: 'escrow_disputed',
        },
      }),
    ]).catch((error) =>
      this.logger.error('Escrow dispute notification failed', error),
    );

    return { message: 'Dispute raised. Admin will review within 24 hours.' };
  }

  private async uploadDisputeAttachment(
    escrowId: string,
    mimeType: string,
    base64: string,
  ): Promise<string> {
    const allowedMimeTypes = new Set([
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
      'image/heic',
      'image/heif',
      'video/mp4',
      'video/quicktime',
      'video/webm',
      'video/x-m4v',
    ]);
    if (!allowedMimeTypes.has(mimeType)) {
      throw new BadRequestException('Only photos and videos are supported');
    }
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        base64,
      )
    ) {
      throw new BadRequestException('Invalid attachment data');
    }

    const bytes = Buffer.from(base64, 'base64');
    const maxAttachmentBytes = 20 * 1024 * 1024;
    if (
      bytes.length === 0 ||
      bytes.length > maxAttachmentBytes ||
      bytes.toString('base64') !== base64
    ) {
      throw new BadRequestException('Attachments must be smaller than 20 MB');
    }

    if (!this.cloudinaryService) {
      throw new Error('Escrow evidence storage is not configured');
    }
    return this.cloudinaryService.uploadEscrowEvidence(
      mimeType,
      base64,
      escrowId,
    );
  }

  async cancel(escrowId: string, userId: string) {
    const escrow = await this.getEscrowOrFail(escrowId);
    if (escrow.buyer_id !== userId)
      throw new ForbiddenException('Only buyer can cancel');
    if (escrow.status === 'active')
      throw new BadRequestException(
        'Cannot cancel a funded escrow. Raise a dispute instead.',
      );
    if (escrow.status !== 'pending')
      throw new BadRequestException(
        `Cannot cancel escrow with status: ${escrow.status}`,
      );
    await this.prisma.escrow_contracts.update({
      where: { id: escrowId },
      data: { status: 'cancelled' },
    });
    if (!escrow.seller_id)
      throw new BadRequestException('Escrow has no seller');

    await this.notificationsService
      .sendNotification(escrow.seller_id, {
        type: 'escrow_cancelled',
        entityId: escrow.id,
        title: 'Escrow Cancelled',
        body: `The escrow for ${escrow.title} has been cancelled by the buyer.`,
        metadata: {
          escrow_id: escrow.id,
          title: escrow.title,
          amount: Number(escrow.amount),
          cancelled_by: userId,
        },
      })
      .catch((error) =>
        this.logger.error('Escrow cancellation notification failed', error),
      );

    return { message: 'Escrow cancelled' };
  }

  async addMessage(escrowId: string, senderId: string, message: string) {
    const escrow = await this.getEscrowOrFail(escrowId);
    if (escrow.buyer_id !== senderId && escrow.seller_id !== senderId)
      throw new ForbiddenException('Not a party to this escrow');
    const msg = await this.prisma.escrow_messages.create({
      data: { escrow_id: escrowId, sender_id: senderId, message },
    });
    return { data: msg };
  }

  async list(userId: string, query: any) {
    const { skip, take, page, limit } = paginationParams(
      query.page,
      query.limit,
    );
    const where: any = { OR: [{ buyer_id: userId }, { seller_id: userId }] };
    if (query.status) where.status = query.status;
    const [items, total] = await Promise.all([
      this.prisma.escrow_contracts.findMany({
        where,
        skip,
        take,
        orderBy: { created_at: 'desc' },
        include: {
          escrow_messages: { orderBy: { created_at: 'asc' } },
          users_escrow_contracts_buyer_idTousers: true,
          users_escrow_contracts_seller_idTousers: true,
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

  async getOne(escrowId: string, userId: string) {
    const escrow = await this.prisma.escrow_contracts.findUnique({
      where: { id: escrowId },
      include: {
        escrow_messages: { orderBy: { created_at: 'asc' } },
        users_escrow_contracts_buyer_idTousers: {
          select: { username: true, first_name: true },
        },
        users_escrow_contracts_seller_idTousers: {
          select: { username: true, first_name: true },
        },
      },
    });
    if (!escrow) throw new NotFoundException('Escrow not found');
    if (escrow.buyer_id !== userId && escrow.seller_id !== userId)
      throw new ForbiddenException('Access denied');
    const releaseTransaction = await this.prisma.transactions.findFirst({
      where: {
        transaction_type: 'escrow_release',
        metadata: { path: ['escrow_id'], equals: escrowId } as any,
      },
      select: { fee: true, transaction_reference: true },
    });
    return {
      data: {
        ...escrow,
        amount: Number(escrow.amount),
        fee: Number(escrow.fee),
        sender_username:
          escrow.users_escrow_contracts_buyer_idTousers?.username ?? null,
        recipient_username:
          escrow.users_escrow_contracts_seller_idTousers?.username ?? null,
        release_fee:
          releaseTransaction == null
            ? null
            : Number(releaseTransaction.fee ?? 0),
        release_transaction_reference:
          releaseTransaction?.transaction_reference ?? null,
      },
    };
  }

  async processAutoReleases() {
    const expired = await this.prisma.escrow_contracts.findMany({
      where: { status: 'active', auto_release_at: { lte: new Date() } },
    });
    let released = 0;
    for (const escrow of expired) {
      try {
        await this.executeRelease(escrow);
        released++;
      } catch (e) {
        this.logger.error(`Auto-release failed for ${escrow.id}: ${e}`);
      }
    }
    if (released) this.logger.log(`Auto-released ${released} escrow(s)`);
    return released;
  }

  /**
   * Releases part of an active escrow to the seller (one milestone). Funds move
   * only here, inside one DB transaction, with the same 1.5% release fee as a
   * full release. When the last part is released the escrow completes.
   */
  async releasePartial(
    escrowId: string,
    buyerId: string,
    amount: number,
    pin: string,
    label: string,
  ) {
    const part = Number(Number(amount).toFixed(2));
    if (!Number.isFinite(part) || part <= 0)
      throw new BadRequestException('Release amount must be positive');
    const escrow = await this.getEscrowOrFail(escrowId);
    if (escrow.buyer_id !== buyerId)
      throw new ForbiddenException('Only the buyer can release');
    if (escrow.status !== 'active')
      throw new BadRequestException(
        `Cannot release escrow with status: ${escrow.status}`,
      );
    if (!escrow.buyer_wallet_id || !escrow.seller_wallet_id)
      throw new BadRequestException(
        'Escrow is missing a buyer or seller wallet',
      );
    await this.authService.verifyPin(buyerId, pin);
    const buyerWalletId = escrow.buyer_wallet_id;
    const sellerWalletId = escrow.seller_wallet_id;
    const sellerId = escrow.seller_id ?? '';

    const fee = await feeFor(this.fees, 'escrow_release', part);
    const toSeller = Number((part - fee).toFixed(8));
    const result = await this.prisma.$transaction(async (tx) => {
      // Atomic claim: never release more than is still locked.
      const rows = await tx.$queryRaw<{ amount: any; released_amount: any }[]>`
        UPDATE escrow_contracts
           SET released_amount = released_amount + ${part}::numeric,
               updated_at = now()
         WHERE id = ${escrow.id}::uuid
           AND status = 'active'
           AND released_amount + ${part}::numeric <= amount
        RETURNING amount, released_amount`;
      if (!rows.length)
        throw new BadRequestException(
          'Escrow is no longer active or the amount exceeds what is still locked',
        );
      const completed = remainingAmount(rows[0]) <= 0;
      if (completed)
        await tx.escrow_contracts.update({
          where: { id: escrow.id },
          data: { status: 'completed', released_at: new Date() },
        });
      const buyerWallet = await tx.wallets.update({
        where: { id: buyerWalletId },
        data: {
          locked_balance: { decrement: part },
          balance: { decrement: part },
        },
      });
      const sellerWallet = await tx.wallets.update({
        where: { id: sellerWalletId },
        data: { balance: { increment: toSeller } },
      });
      const txn = await tx.transactions.create({
        data: {
          transaction_reference: generateTxReference(),
          sender_wallet_id: buyerWalletId,
          receiver_wallet_id: sellerWalletId,
          transaction_type: 'escrow_release',
          status: 'completed',
          amount: part,
          fee,
          net_amount: toSeller,
          description: `Escrow milestone release: ${label}`,
          metadata: {
            user_id: buyerId,
            escrow_id: escrow.id,
            partial: true,
            milestone: label,
          },
          processed_at: new Date(),
        },
      });
      await tx.ledger_entries.createMany({
        data: [
          {
            transaction_id: txn.id,
            wallet_id: buyerWalletId,
            entry_type: 'debit',
            amount: part,
            description: `Escrow milestone ${escrow.reference_code}: ${label}`,
          },
          {
            transaction_id: txn.id,
            wallet_id: sellerWalletId,
            entry_type: 'credit',
            amount: toSeller,
            description: `Escrow milestone ${escrow.reference_code}: ${label} (after release fee)`,
          },
        ],
      });
      if (fee > 0)
        await this.creditSuperadminWalletInTx(
          tx,
          fee,
          `Escrow milestone release fee: ${escrow.title}`,
        );
      return {
        completed,
        released_amount: Number(rows[0].released_amount),
        remaining: remainingAmount(rows[0]),
        buyerBalance: Number(buyerWallet.balance),
        sellerBalance: Number(sellerWallet.balance),
        transaction_reference: txn.transaction_reference,
      };
    });
    try {
      this.websocket.emitBalanceUpdate(buyerId, result.buyerBalance);
      this.websocket.emitBalanceUpdate(sellerId, result.sellerBalance);
    } catch {
      /* realtime is best effort */
    }
    await this.notificationsService
      .sendNotification(sellerId, {
        type: 'escrow_received',
        title: 'Milestone released',
        body: `${toSeller} FARM was released to you for "${label}" (${escrow.title}).`,
        entityId: escrow.id,
        metadata: {
          escrow_id: escrow.id,
          amount: part,
          net_amount: toSeller,
          event: 'escrow_milestone_released',
          transaction_reference: result.transaction_reference,
          transaction_type: 'escrow_release',
        },
      })
      .catch(() => undefined);
    return {
      data: {
        transaction_reference: result.transaction_reference,
        amount: part,
        fee,
        net_amount: toSeller,
        released_amount: result.released_amount,
        remaining: result.remaining,
        completed: result.completed,
      },
      message: result.completed
        ? 'Final milestone released'
        : 'Milestone released',
    };
  }

  async executeRelease(
    escrow: any,
    resolution?: { adminId: string; note: string },
  ) {
    if (!escrow.buyer_wallet_id || !escrow.seller_wallet_id) {
      throw new BadRequestException(
        'Escrow is missing a buyer or seller wallet',
      );
    }
    if (!Number.isFinite(Number(escrow.amount)) || Number(escrow.amount) <= 0) {
      throw new BadRequestException('Escrow amount is invalid');
    }
    let releaseFee = 0;
    const releaseRuleCfg = await ruleFor(this.fees, 'escrow_release');
    const releaseRule = (amt: number) => computeFee(releaseRuleCfg, amt);
    let amountToSeller = 0;
    let amountLocked = 0;

    const result = await this.prisma.$transaction(async (tx) => {
      const resolvedAt = new Date();
      const transitioned = await tx.escrow_contracts.updateMany({
        where: {
          id: escrow.id,
          status: { in: [resolution ? 'disputed' : 'active'] },
        },
        data: {
          status: 'completed',
          released_at: resolvedAt,
          ...(resolution
            ? {
                arbiter_id: resolution.adminId,
                resolution_note: resolution.note,
                resolved_at: resolvedAt,
              }
            : {}),
        },
      });
      if (transitioned.count !== 1) {
        throw new BadRequestException(
          resolution
            ? 'Escrow is no longer disputed'
            : 'Escrow is no longer active',
        );
      }
      // The row is now locked by this transaction; only release what milestone
      // releases have not already paid out.
      const fresh = await tx.escrow_contracts.findUnique({
        where: { id: escrow.id },
        select: { amount: true, released_amount: true },
      });
      amountLocked = remainingAmount(fresh ?? escrow);
      releaseFee = releaseRule(amountLocked); // other half of the 3% escrow fee
      amountToSeller = Number((amountLocked - releaseFee).toFixed(8));
      if (amountLocked <= 0) {
        return {
          buyerBalance: null,
          sellerBalance: null,
          transactionReference: null,
        } as any;
      }
      // Deduct only the locked escrow amount from buyer's wallet. The creation fee was already charged at escrow creation.
      const updatedBuyerWallet = await tx.wallets.update({
        where: { id: escrow.buyer_wallet_id },
        data: {
          locked_balance: { decrement: amountLocked },
          balance: { decrement: amountLocked },
        },
      });
      // Credit seller's wallet with amount minus release fee
      const updatedSellerWallet = await tx.wallets.update({
        where: { id: escrow.seller_wallet_id },
        data: { balance: { increment: amountToSeller } },
      });
      const txn = await tx.transactions.create({
        data: {
          transaction_reference: generateTxReference(),
          sender_wallet_id: escrow.buyer_wallet_id,
          receiver_wallet_id: escrow.seller_wallet_id,
          transaction_type: 'escrow_release',
          status: 'completed',
          amount: amountLocked,
          fee: releaseFee,
          net_amount: amountToSeller,
          description: `Escrow release: ${escrow.title}`,
          metadata: { user_id: escrow.buyer_id, escrow_id: escrow.id },
          processed_at: new Date(),
        },
      });
      await tx.ledger_entries.createMany({
        data: [
          {
            transaction_id: txn.id,
            wallet_id: escrow.buyer_wallet_id,
            entry_type: 'debit',
            amount: amountLocked,
            description: `Escrow release ${escrow.reference_code}`,
          },
          {
            transaction_id: txn.id,
            wallet_id: escrow.seller_wallet_id,
            entry_type: 'credit',
            amount: amountToSeller,
            description: `Escrow release ${escrow.reference_code} (after release fee)`,
          },
        ],
      });
      // Credit release fee to superadmin wallet
      if (releaseFee > 0) {
        await this.creditSuperadminWalletInTx(
          tx,
          releaseFee,
          `Escrow release fee: ${escrow.title}`,
        );
      }
      return {
        buyerBalance: Number(updatedBuyerWallet.balance),
        sellerBalance: Number(updatedSellerWallet.balance),
        transactionReference: txn.transaction_reference,
      };
    });

    if (!result.transactionReference) return;
    try {
      this.websocket.emitBalanceUpdate(escrow.buyer_id, result.buyerBalance);
      this.websocket.emitTransactionUpdate(escrow.buyer_id, {
        reference: result.transactionReference,
        status: 'SUCCESS',
      });
      this.websocket.emitBalanceUpdate(escrow.seller_id, result.sellerBalance);
      this.websocket.emitTransactionUpdate(escrow.seller_id, {
        reference: result.transactionReference,
        status: 'SUCCESS',
      });
    } catch (error) {
      this.logger.warn(
        `Escrow release realtime update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const buyerResolutionMessage = resolution
      ? `An admin resolved the dispute in the seller's favor. ${amountToSeller} FARM was credited to the seller.${resolution.note ? ` Note: ${resolution.note}` : ''}`
      : null;
    const sellerResolutionMessage = resolution
      ? `An admin resolved the dispute in your favor. ${amountToSeller} FARM was credited to your wallet.${resolution.note ? ` Note: ${resolution.note}` : ''}`
      : null;
    await Promise.all([
      this.notificationsService.sendNotification(escrow.buyer_id, {
        type: 'escrow_released',
        title: 'Escrow released',
        body:
          buyerResolutionMessage ??
          `Your escrow for ${escrow.title} was released and ${amountToSeller} FARM was paid to the seller.`,
        entityId: escrow.id,
        metadata: {
          escrow_id: escrow.id,
          amount: Number(escrow.amount),
          released_amount: amountToSeller,
          seller_id: escrow.seller_id,
          event: 'escrow_released',
          transaction_reference: result.transactionReference,
          transaction_type: 'escrow_release',
          ...(resolution ? { credited_user_id: escrow.seller_id } : {}),
          ...(resolution ? { resolution_note: resolution.note } : {}),
        },
      }),
      this.notificationsService.sendNotification(escrow.seller_id, {
        type: 'escrow_received',
        title: 'Escrow payment released',
        body:
          sellerResolutionMessage ??
          `Escrow for ${escrow.title} was released and ${amountToSeller} FARM credited to your wallet.`,
        entityId: escrow.id,
        metadata: {
          escrow_id: escrow.id,
          amount: Number(escrow.amount),
          net_amount: amountToSeller,
          buyer_id: escrow.buyer_id,
          event: resolution ? 'escrow_dispute_resolved' : 'escrow_received',
          transaction_reference: result.transactionReference,
          transaction_type: 'escrow_release',
          ...(resolution ? { credited_user_id: escrow.seller_id } : {}),
          ...(resolution ? { resolution_note: resolution.note } : {}),
        },
      }),
    ]).catch((error) =>
      this.logger.error('Escrow release notification failed', error),
    );
  }

  async executeRefund(
    escrow: any,
    resolution?: { adminId: string; note: string },
  ) {
    let amount = 0;
    const result = await this.prisma.$transaction(async (tx) => {
      const resolvedAt = new Date();
      const transitioned = await tx.escrow_contracts.updateMany({
        where: {
          id: escrow.id,
          status: { in: [resolution ? 'disputed' : 'active'] },
        },
        data: {
          status: 'refunded',
          resolved_at: resolvedAt,
          ...(resolution
            ? {
                arbiter_id: resolution.adminId,
                resolution_note: resolution.note,
              }
            : {}),
        },
      });
      if (transitioned.count !== 1) {
        throw new BadRequestException(
          resolution
            ? 'Escrow is no longer disputed'
            : 'Escrow is no longer active',
        );
      }
      const fresh = await tx.escrow_contracts.findUnique({
        where: { id: escrow.id },
        select: { amount: true, released_amount: true },
      });
      amount = remainingAmount(fresh ?? escrow);
      const updatedWallet = await tx.wallets.update({
        where: { id: escrow.buyer_wallet_id },
        data: { locked_balance: { decrement: amount } },
      });
      const transaction = await tx.transactions.create({
        data: {
          transaction_reference: generateTxReference(),
          receiver_wallet_id: escrow.buyer_wallet_id,
          transaction_type: 'escrow_refund',
          status: 'completed',
          amount,
          fee: 0,
          net_amount: amount,
          description: `Escrow refund: ${escrow.title}`,
          metadata: { user_id: escrow.buyer_id, escrow_id: escrow.id },
          processed_at: new Date(),
        },
      });
      return {
        balance: Number(updatedWallet.balance),
        transactionReference: transaction.transaction_reference,
      };
    });

    try {
      this.websocket.emitBalanceUpdate(escrow.buyer_id, result.balance);
      this.websocket.emitTransactionUpdate(escrow.buyer_id, {
        reference: result.transactionReference,
        status: 'SUCCESS',
      });
    } catch (error) {
      this.logger.warn(
        `Escrow refund realtime update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const resolutionText = resolution
      ? `An admin resolved the dispute in your favor. ${amount} FARM was credited to your wallet. The escrow creation fee is non-refundable.${resolution.note ? ` Note: ${resolution.note}` : ''}`
      : `Your escrow for ${escrow.title} has been refunded. ${amount} FARM was returned. The escrow creation fee is non-refundable.`;
    const refundNotifications = [
      this.notificationsService.sendNotification(escrow.buyer_id, {
        type: 'escrow_refunded',
        title: 'Escrow refunded',
        body: resolutionText,
        entityId: escrow.id,
        metadata: {
          escrow_id: escrow.id,
          amount,
          refunded_amount: amount,
          creation_fee_refunded: 0,
          event: resolution ? 'escrow_dispute_resolved' : 'escrow_refunded',
          transaction_reference: result.transactionReference,
          transaction_type: 'escrow_refund',
          ...(resolution ? { credited_user_id: escrow.buyer_id } : {}),
          ...(resolution ? { resolution_note: resolution.note } : {}),
        },
      }),
    ];
    if (resolution && escrow.seller_id) {
      refundNotifications.push(
        this.notificationsService.sendNotification(escrow.seller_id, {
          type: 'escrow_refunded',
          title: "Dispute resolved in buyer's favor",
          body: `The disputed escrow for ${escrow.title} was refunded to the buyer. ${amount} FARM was returned; the escrow creation fee is non-refundable.${resolution.note ? ` Note: ${resolution.note}` : ''}`,
          entityId: escrow.id,
          metadata: {
            escrow_id: escrow.id,
            amount,
            refunded_amount: amount,
            creation_fee_refunded: 0,
            event: 'escrow_dispute_resolved',
            transaction_reference: result.transactionReference,
            transaction_type: 'escrow_refund',
            credited_user_id: escrow.buyer_id,
            resolution_note: resolution.note,
          },
        }),
      );
    }
    await Promise.all(refundNotifications).catch((error) =>
      this.logger.error('Escrow refund notification failed', error),
    );
  }

  private async getEscrowOrFail(id: string) {
    const e = await this.prisma.escrow_contracts.findUnique({ where: { id } });
    if (!e) throw new NotFoundException('Escrow contract not found');
    return e;
  }
}
