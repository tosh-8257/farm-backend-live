import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { AuthService } from '../auth/auth.service';
import { AlgorandWalletClient } from '../chain-wallet/algorand-wallet.client';
import { FeeTopupService } from '../chain-wallet/fee-topup.service';
import { walletSigner } from '../chain-wallet/key-vault';
import { AlgorandAsaClient } from './algorand-asa.client';
import { OPT_IN_NEED, onInvestConfig } from './on-invest';

export const transfersEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.TOKEN_TRANSFERS_ENABLED === 'true';

const DB_MOVABLE = ['held', 'owed'];
const OPEN_BUYBACK = ['requested', 'approved', 'returning'];

/**
 * Send project tokens to another FARM user (by username or phone).
 *  - held / owed holdings: DB move (a new holding for the recipient, same
 *    status; the delivery job later sends owed tokens to their wallet).
 *  - delivered holdings: on-chain ASA move between in-app wallets. FARM's
 *    issuer is the token's clawback account, so the move is signed by the
 *    issuer (fee pooled by the funder). The recipient's opt-in is done by the
 *    backend with ALGO from the capped top-up only.
 * No transfer fee (internal transfer rule); network fee only, paid by FARM.
 * Idempotent outbox: the source holding is reduced with a compare-and-set,
 * txId/lastValid are stored before sending, and stuck rows are settled from
 * the chain (confirmed -> completed, expired -> units restored).
 * Received tokens carry income (distributions) but NO sell-back allowance:
 * sell-back stays tied to the holder's own investment.
 */
@Injectable()
export class TokenTransferService {
  private readonly log = new Logger(TokenTransferService.name);
  private busy = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly chain: AlgorandWalletClient,
    private readonly asa: AlgorandAsaClient,
    @Optional() private readonly topup?: FeeTopupService,
  ) {}

  async send(
    userId: string,
    allocationId: string,
    dto: { recipient_identifier: string; units: number; pin: string },
  ) {
    if (!transfersEnabled())
      throw new BadRequestException('Token transfers are not switched on yet');
    const units = dto.units;
    if (!Number.isInteger(units) || units < 1)
      throw new BadRequestException('Units must be a whole number above 0');
    if (!dto.pin) throw new BadRequestException('Transaction PIN is required');
    await this.auth.verifyPin(userId, dto.pin);
    const a = await this.prisma.token_allocations.findUnique({
      where: { id: allocationId },
      include: { token: { include: { project: true } } },
    });
    if (!a || a.user_id !== userId)
      throw new NotFoundException('Token holding not found');
    if (a.token.project?.status === 'cancelled')
      throw new BadRequestException('This project was cancelled');
    const chainMove = a.status === 'delivered';
    if (!chainMove && !DB_MOVABLE.includes(a.status))
      throw new BadRequestException('These tokens cannot be sent right now');
    const free = BigInt(a.units) - BigInt(a.sold_units ?? 0);
    if (BigInt(units) > free)
      throw new BadRequestException(`You hold ${free} tokens here`);
    const who = dto.recipient_identifier?.trim();
    const to = await this.prisma.users.findFirst({
      where: {
        OR: [{ username: who }, { phone: who }],
        is_deleted: false,
        is_active: true,
      },
      select: { id: true },
    });
    if (!to) throw new NotFoundException('Recipient not found');
    if (to.id === userId)
      throw new BadRequestException('You cannot send tokens to yourself');
    const openBuyback = await this.prisma.token_buybacks.count({
      where: { allocation_id: a.id, status: { in: OPEN_BUYBACK } },
    });
    if (openBuyback)
      throw new BadRequestException(
        'These tokens have an open sell-back request',
      );

    let toAddress: string | null = null;
    if (chainMove) {
      if (!onInvestConfig().enabled || a.token.asset_id == null || !a.address)
        throw new BadRequestException('On-chain transfers are switched off');
      toAddress = await this.readyRecipient(
        to.id,
        a.token.network,
        BigInt(a.token.asset_id),
      );
    }

    // Reduce the source and create the recipient's holding atomically.
    const t = await this.prisma.$transaction(async (tx) => {
      const left = BigInt(a.units) - BigInt(units);
      const claim = await tx.token_allocations.updateMany({
        where: {
          id: a.id,
          status: a.status,
          units: BigInt(a.units),
          sold_units: BigInt(a.sold_units ?? 0),
        },
        data: {
          units: left,
          ...(left - BigInt(a.sold_units ?? 0) <= 0n
            ? { status: 'transferred' }
            : {}),
        },
      });
      if (!claim.count)
        throw new BadRequestException('Holding changed, please retry');
      const dest = await tx.token_allocations.create({
        data: {
          project_token_id: a.project_token_id,
          investment_id: null,
          user_id: to.id,
          units: BigInt(units),
          custody: a.custody,
          source: 'transfer',
          from_allocation_id: a.id,
          status: chainMove ? 'incoming' : a.status,
          address: toAddress,
        },
      });
      return tx.token_transfers.create({
        data: {
          project_token_id: a.project_token_id,
          from_allocation_id: a.id,
          to_allocation_id: dest.id,
          from_user_id: userId,
          to_user_id: to.id,
          units: BigInt(units),
          mode: chainMove ? 'chain' : 'db',
          status: chainMove ? 'sending' : 'completed',
          from_address: a.address,
          to_address: toAddress,
        },
      });
    });
    if (!chainMove) return { data: this.shape(t), message: 'Tokens sent' };

    let issuer: any;
    try {
      issuer = this.asa.issuerSigner();
      const prep = await this.chain.prepareClawback({
        clawback: issuer,
        from: a.address!,
        to: toAddress!,
        assetId: BigInt(a.token.asset_id!),
        amount: BigInt(units),
        note: `farm:token:transfer:${t.id}`,
      });
      await this.prisma.token_transfers.update({
        where: { id: t.id },
        data: { tx_id: prep.txId, last_valid: prep.lastValid },
      });
      await prep.send();
      await this.complete(t.id);
      return {
        data: { ...this.shape(t), status: 'completed', tx_id: prep.txId },
        message: 'Tokens sent',
      };
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      this.log.warn(`Token transfer ${t.id} send failed: ${msg}`);
      const row = await this.prisma.token_transfers.findUnique({
        where: { id: t.id },
      });
      if (!row?.tx_id) await this.revert(t.id, msg);
      else
        await this.prisma.token_transfers.update({
          where: { id: t.id },
          data: { error: msg },
        });
      return {
        data: { ...this.shape(t), status: row?.tx_id ? 'sending' : 'reverted' },
        message: row?.tx_id
          ? 'Sending; it will be confirmed shortly'
          : 'Transfer failed; your tokens were not moved',
      };
    } finally {
      issuer?.wipe?.();
    }
  }

  /** Recipient's ready in-app wallet, opted in (backend opt-in, capped ALGO). */
  private async readyRecipient(
    userId: string,
    network: string,
    assetId: bigint,
  ) {
    const w = await this.prisma.user_chain_wallets.findUnique({
      where: { user_id: userId },
    });
    if (!w || w.status !== 'ready' || w.network !== network)
      throw new BadRequestException(
        'The recipient has no ready FARM wallet for this token yet',
      );
    if (!(await this.chain.isOptedIn(w.address, assetId))) {
      const t = this.topup
        ? await this.topup.ensure(w.address, 'token_optin', OPT_IN_NEED)
        : 'disabled';
      if (t !== 'enough' && t !== 'sent')
        throw new BadRequestException(
          `Recipient wallet can't receive this token yet (${t}); try again later`,
        );
      const sk = walletSigner(w);
      try {
        await this.chain.optIn(w.address, sk, assetId);
      } finally {
        sk.wipe();
      }
    }
    return w.address;
  }

  private async complete(id: string) {
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.token_transfers.updateMany({
        where: { id, status: 'sending' },
        data: { status: 'completed', error: null },
      });
      if (!c.count) return;
      const t = (await tx.token_transfers.findUnique({ where: { id } }))!;
      await tx.token_allocations.updateMany({
        where: { id: t.to_allocation_id!, status: 'incoming' },
        data: { status: 'delivered', delivered_at: new Date(), tx_id: t.tx_id },
      });
    });
  }

  /** Expired / never sent: give the units back to the sender. */
  private async revert(id: string, msg: string) {
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.token_transfers.updateMany({
        where: { id, status: 'sending' },
        data: { status: 'reverted', error: msg },
      });
      if (!c.count) return;
      const t = (await tx.token_transfers.findUnique({ where: { id } }))!;
      await tx.token_allocations.update({
        where: { id: t.from_allocation_id },
        data: { units: { increment: t.units }, status: 'delivered' },
      });
      await tx.token_allocations.updateMany({
        where: { id: t.to_allocation_id!, status: 'incoming' },
        data: { status: 'cancelled', units: 0n },
      });
    });
  }

  @Interval('farm-token-transfers', 30_000)
  async tick() {
    if (!transfersEnabled() || this.busy) return;
    this.busy = true;
    try {
      await this.resolveStuck();
    } catch (e: any) {
      this.log.warn(`Token transfer tick failed: ${e?.message ?? e}`);
    } finally {
      this.busy = false;
    }
  }

  async resolveStuck() {
    const rows = await this.prisma.token_transfers.findMany({
      where: {
        status: 'sending',
        updated_at: { lt: new Date(Date.now() - 60_000) },
      },
      take: 50,
    });
    if (!rows.length) return;
    const round = await this.chain.currentRound();
    for (const r of rows) {
      const st = r.tx_id ? await this.chain.txStatus(r.tx_id) : 'unknown';
      if (st === 'confirmed') await this.complete(r.id);
      else if (
        !r.tx_id ||
        (r.last_valid != null && round > BigInt(r.last_valid))
      )
        await this.revert(r.id, 'expired unconfirmed');
    }
  }

  async mine(userId: string) {
    const rows = await this.prisma.token_transfers.findMany({
      where: { OR: [{ from_user_id: userId }, { to_user_id: userId }] },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    return {
      data: rows.map((r) => ({
        ...this.shape(r),
        direction: r.from_user_id === userId ? 'out' : 'in',
      })),
    };
  }

  private shape(r: any) {
    return {
      id: r.id,
      units: r.units?.toString(),
      mode: r.mode,
      status: r.status,
      tx_id: r.tx_id ?? null,
      from_user_id: r.from_user_id,
      to_user_id: r.to_user_id,
      created_at: r.created_at,
    };
  }
}
