import { Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { AlgorandWalletClient } from './algorand-wallet.client';
import { chainConfig, FARM_DECIMALS } from './chain-config';
import { walletSigner } from './key-vault';
import { AlgoSigner } from './signer';
import { FeeTopupService } from './fee-topup.service';

const toUnits = (v: unknown) =>
  BigInt(Math.floor(Number(v ?? 0) * 10 ** FARM_DECIMALS));
/** Transaction types whose funds are already held by the reserve. */
export const RESERVE_FUNDED = new Set(['escrow_release']);
const backoff = (attempts: number) =>
  new Date(Date.now() + Math.min(30_000 * 2 ** attempts, 3_600_000));

/**
 * Moves FARM on chain for every completed ledger transaction (transactional
 * outbox derived from the committed ledger, so DB and chain cannot silently
 * diverge):
 *  1. enqueue(): ledger rows -> chain_outbox (unique per transaction+leg).
 *  2. process(): txId + lastValid are stored BEFORE sending; a retry first asks
 *     the chain whether that txId confirmed and only rebuilds after lastValid
 *     has passed, so a transfer is never sent twice.
 * Receive-only: destinations are restricted to FARM custodial accounts and the
 * FARM reserve. There is no path to an external address.
 */
@Injectable()
export class ChainSyncService {
  private readonly log = new Logger(ChainSyncService.name);
  private busy = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: AlgorandWalletClient,
    @Optional() private readonly topup?: FeeTopupService,
  ) {}

  @Interval('farm-chain-sync', 30_000)
  async tick() {
    if (!chainConfig().sync.enabled || this.busy) return;
    this.busy = true;
    try {
      await this.enqueue();
      await this.process();
    } catch (e: any) {
      this.log.warn(`Chain sync tick failed: ${e?.message ?? e}`);
    } finally {
      this.busy = false;
    }
  }

  private async addressOf(walletIds: string[]) {
    const ws = walletIds.length
      ? await this.prisma.wallets.findMany({
          where: { id: { in: walletIds } },
          select: { id: true, user_id: true, wallet_type: true },
        })
      : [];
    const userIds = ws
      .filter(
        (w) =>
          w.user_id &&
          w.wallet_type !== 'platform' &&
          w.wallet_type !== 'treasury',
      )
      .map((w) => w.user_id!);
    const cws = userIds.length
      ? await this.prisma.user_chain_wallets.findMany({
          where: { user_id: { in: userIds }, status: 'ready' },
          select: { user_id: true, address: true },
        })
      : [];
    const addrByUser = new Map(cws.map((c) => [c.user_id, c.address]));
    // Business (merchant) wallets have their own custodial account.
    const bizIds = ws
      .filter((w) => !w.user_id && w.wallet_type === 'merchant')
      .map((w) => w.id);
    const bws = bizIds.length
      ? await this.prisma.business_chain_wallets?.findMany({
          where: { wallet_id: { in: bizIds }, status: 'ready' },
          select: { wallet_id: true, address: true },
        })
      : [];
    const addrByWallet = new Map(
      (bws ?? []).map((b) => [b.wallet_id, b.address]),
    );
    const reserve = process.env.FARM_RESERVE_ADDRESS!;
    return new Map(
      ws.map((w) => {
        const a = w.user_id
          ? addrByUser.get(w.user_id)
          : addrByWallet.get(w.id);
        return [
          w.id,
          a
            ? { user_id: w.user_id, address: a }
            : { user_id: null, address: reserve },
        ];
      }),
    );
  }

  /**
   * One-time go-live boundary. Transactions already completed before sync was
   * switched on are matched by reconciliation, so they are marked as handled;
   * anything completed afterwards (including rows created earlier as pending
   * or processing) is enqueued when it completes.
   */
  private async ensureGoLive(network: string) {
    const key = `${network}:outbox:golive_ms`;
    if (await this.prisma.chain_sync_state.findUnique({ where: { key } }))
      return;
    const legacy = await this.prisma.chain_sync_state.findUnique({
      where: { key: `${network}:outbox:ledger_ms` },
    });
    const cutoff = legacy ? Number(legacy.last_round) : Date.now();
    try {
      await this.prisma.$transaction(async (tx: any) => {
        await tx.chain_sync_state.create({
          data: { key, last_round: BigInt(cutoff) },
        });
        await tx.transactions.updateMany({
          where: {
            status: 'completed',
            chain_enqueued_at: null,
            created_at: { lt: new Date(cutoff) },
          },
          data: { chain_enqueued_at: new Date() },
        });
      });
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e; // another worker set it first
    }
  }

  /**
   * Ledger -> outbox for every completed transaction not yet enqueued, no
   * matter when it completed. The outbox rows and the per-transaction marker
   * are written in one DB transaction; (transaction_id, leg) is unique, so a
   * re-scan can never create a second transfer.
   */
  async enqueue(limit = 200) {
    const c = chainConfig();
    if (!c.sync.enabled) return { enqueued: 0, disabled: true };
    await this.ensureGoLive(c.network);
    const txs = await this.prisma.transactions.findMany({
      where: { status: 'completed', chain_enqueued_at: null },
      orderBy: { created_at: 'asc' },
      take: limit,
      select: {
        id: true,
        sender_wallet_id: true,
        receiver_wallet_id: true,
        transaction_type: true,
        amount: true,
        fee: true,
        net_amount: true,
        metadata: true,
        created_at: true,
      },
    });
    if (!txs.length) return { enqueued: 0 };
    const ids = [
      ...new Set(
        txs
          .flatMap((t) => [t.sender_wallet_id, t.receiver_wallet_id])
          .filter(Boolean) as string[],
      ),
    ];
    const map = await this.addressOf(ids);
    const reserve = {
      user_id: null as string | null,
      address: process.env.FARM_RESERVE_ADDRESS!,
    };
    const rows: any[] = [];
    for (const t of txs) {
      if ((t.metadata as any)?.chain_settled === true) continue; // already on chain / never left the reserve
      // Funds of a released escrow already sit in the reserve (the lock moved
      // buyer -> reserve), so the release is paid out of the reserve.
      const fromReserve = RESERVE_FUNDED.has(String(t.transaction_type));
      const from = fromReserve
        ? reserve
        : (t.sender_wallet_id && map.get(t.sender_wallet_id)) || reserve;
      const to =
        (t.receiver_wallet_id && map.get(t.receiver_wallet_id)) || reserve;
      const net = toUnits(
        t.net_amount && Number(t.net_amount) > 0 ? t.net_amount : t.amount,
      );
      const fee = toUnits(t.fee);
      const legs: [string, typeof from, typeof to, bigint][] = [
        ['main', from, to, net],
      ];
      if (fee > 0n && t.sender_wallet_id)
        legs.push(['fee', from, reserve, fee]);
      for (const [leg, f, d, units] of legs) {
        if (units <= 0n || f.address === d.address) continue;
        rows.push({
          transaction_id: t.id,
          leg,
          network: c.network,
          from_user_id: f.user_id,
          to_user_id: d.user_id,
          from_address: f.address,
          to_address: d.address,
          amount_units: units,
        });
      }
    }
    const count = await this.prisma.$transaction(async (tx: any) => {
      const ins = rows.length
        ? await tx.chain_outbox.createMany({ data: rows, skipDuplicates: true })
        : { count: 0 };
      await tx.transactions.updateMany({
        where: {
          id: { in: txs.map((t) => t.id) },
          status: 'completed',
          chain_enqueued_at: null,
        },
        data: { chain_enqueued_at: new Date() },
      });
      return ins.count as number;
    });
    return { enqueued: count };
  }

  /** Receive-only guard: only FARM-controlled destinations. */
  private async assertInternal(address: string) {
    if (address === process.env.FARM_RESERVE_ADDRESS) return;
    const w =
      (await this.prisma.user_chain_wallets.findUnique({
        where: { address },
      })) ??
      (await this.prisma.business_chain_wallets?.findUnique({
        where: { address },
      }));
    if (!w)
      throw new Error(
        'Destination is not a FARM account (receive-only policy)',
      );
  }

  async process(limit = 20) {
    if (!chainConfig().sync.enabled)
      return { processed: 0, sent: 0, disabled: true };
    const rows = await this.prisma.chain_outbox.findMany({
      where: {
        status: { in: ['pending', 'failed', 'blocked'] },
        next_attempt_at: { lte: new Date() },
      },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
    let sent = 0;
    for (const r of rows) if (await this.processOne(r)) sent++;
    return { processed: rows.length, sent };
  }

  async processOne(r: any): Promise<boolean> {
    const claim = await this.prisma.chain_outbox.updateMany({
      where: { id: r.id, status: r.status },
      data: { status: 'sending', attempts: { increment: 1 } },
    });
    if (!claim.count) return false;
    const fail = (status: string, err: string) =>
      this.prisma.chain_outbox.update({
        where: { id: r.id },
        data: {
          status,
          last_error: err.slice(0, 300),
          next_attempt_at: backoff(r.attempts),
        },
      });
    let sk: AlgoSigner | null = null;
    try {
      // A previous attempt may have reached the chain: never resend blindly.
      if (r.tx_id) {
        const st = await this.chain.txStatus(r.tx_id);
        if (st === 'confirmed') {
          await this.prisma.chain_outbox.update({
            where: { id: r.id },
            data: { status: 'sent', sent_at: new Date(), last_error: null },
          });
          return true;
        }
        if (
          st === 'pending' ||
          (await this.chain.currentRound()) <= BigInt(r.last_valid ?? 0)
        ) {
          await fail(
            'failed',
            'waiting for previous attempt to confirm or expire',
          );
          return false;
        }
      }
      await this.assertInternal(r.to_address);
      const asset = BigInt(process.env.FARM_ASA_ID!);
      const bal = await this.chain.assetBalance(r.from_address, asset);
      if (bal < BigInt(r.amount_units)) {
        await fail(
          'blocked',
          'sender has not enough FARM on chain yet (run reconciliation)',
        );
        return false;
      }
      if (r.from_address === process.env.FARM_RESERVE_ADDRESS)
        sk = this.chain.reserveSigner();
      else {
        const w =
          (await this.prisma.user_chain_wallets.findUnique({
            where: { address: r.from_address },
          })) ??
          (await this.prisma.business_chain_wallets?.findUnique({
            where: { address: r.from_address },
          }));
        if (!w || w.status !== 'ready')
          throw new Error('Sender wallet not ready');
        await this.topup?.ensure(r.from_address, 'sync');
        sk = walletSigner(w);
      }
      const prep = await this.chain.prepareFarmTransfer({
        from: r.from_address,
        signer: sk,
        to: r.to_address,
        assetId: asset,
        amount: BigInt(r.amount_units),
        note: `farm:tx:${r.transaction_id}:${r.leg}`,
      });
      await this.prisma.chain_outbox.update({
        where: { id: r.id },
        data: { tx_id: prep.txId, last_valid: prep.lastValid },
      });
      await prep.send();
      await this.prisma.chain_outbox.update({
        where: { id: r.id },
        data: { status: 'sent', sent_at: new Date(), last_error: null },
      });
      return true;
    } catch (e: any) {
      await fail('failed', String(e?.message ?? e));
      return false;
    } finally {
      sk?.wipe();
    }
  }

  /** Makes failed/blocked rows due now; safety checks in processOne still apply. */
  async retryNow() {
    const r = await this.prisma.chain_outbox.updateMany({
      where: { status: { in: ['failed', 'blocked'] } },
      data: { next_attempt_at: new Date() },
    });
    return { data: { rescheduled: r.count } };
  }

  async summary() {
    const g = await this.prisma.chain_outbox.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    return {
      data: {
        config: chainConfig().sync,
        outbox: Object.fromEntries(g.map((x) => [x.status, x._count._all])),
      },
    };
  }
}
