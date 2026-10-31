import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { AlgorandWalletClient } from './algorand-wallet.client';
import { chainConfig } from './chain-config';

const algo = (v: string | undefined, d: number) => {
  const n = v == null || v === '' ? NaN : Number(v);
  return BigInt(Math.round((Number.isFinite(n) && n >= 0 ? n : d) * 1e6));
};

/** Env-driven settings (ALGO amounts, converted to microALGO). */
export function topupConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled:
      env.ALGO_FEE_TOPUP_ENABLED === 'true' && chainConfig(env).wallets.enabled,
    threshold: algo(env.ALGO_FEE_TOPUP_THRESHOLD, 0.005),
    amount: algo(env.ALGO_FEE_TOPUP_AMOUNT, 0.05),
    perWalletDaily: algo(env.ALGO_FEE_TOPUP_WALLET_DAILY_CAP, 0.2),
    globalDaily: algo(env.ALGO_FEE_TOPUP_GLOBAL_DAILY_CAP, 2),
    funderFloor: algo(env.ALGO_FEE_TOPUP_FUNDER_FLOOR, 5),
  };
}

export type TopupResult =
  | 'disabled'
  | 'not_farm_wallet'
  | 'enough'
  | 'in_flight'
  | 'wallet_cap'
  | 'global_cap'
  | 'funder_floor'
  | 'sent'
  | 'failed';

/**
 * Keeps FARM custodial wallets able to pay network fees: when spendable ALGO
 * (balance - min balance) falls below the threshold, the funder (Falcon-signed
 * via its key scheme) sends a small top-up. Only ready FARM custodial wallets
 * are eligible; per-wallet and global daily caps and a funder floor apply.
 * Idempotent: one in-flight row per address (partial unique index), the txId
 * is stored before sending and a stuck row is resolved by asking the chain.
 */
@Injectable()
export class FeeTopupService {
  private readonly log = new Logger(FeeTopupService.name);
  private busy = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: AlgorandWalletClient,
  ) {}

  @Interval('farm-algo-fee-topup', 300_000)
  async tick() {
    if (!topupConfig().enabled || this.busy) return;
    this.busy = true;
    try {
      await this.resolveStuck();
      const ws = await this.prisma.user_chain_wallets.findMany({
        where: { status: 'ready', network: chainConfig().network },
        select: { address: true },
        take: 200,
      });
      for (const w of ws) {
        const r = await this.ensure(w.address, 'schedule');
        if (r === 'funder_floor' || r === 'global_cap') break;
      }
    } catch (e: any) {
      this.log.warn(`Fee top-up tick failed: ${e?.message ?? e}`);
    } finally {
      this.busy = false;
    }
  }

  private dayStart() {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private async sentSince(where: any): Promise<bigint> {
    const agg = await this.prisma.chain_fee_topups.aggregate({
      where: {
        ...where,
        status: { in: ['sending', 'sent'] },
        created_at: { gte: this.dayStart() },
      },
      _sum: { micro_algos: true },
    });
    return BigInt(agg._sum.micro_algos ?? 0);
  }

  /** Top up one address if needed. Never throws. */
  async ensure(address: string, reason = 'sync'): Promise<TopupResult> {
    const cfg = topupConfig();
    if (!cfg.enabled) return 'disabled';
    try {
      // Receive-only: FARM custodial wallets only (never the reserve/outside).
      const w = await this.prisma.user_chain_wallets.findUnique({
        where: { address },
      });
      if (
        !w ||
        w.status !== 'ready' ||
        address === process.env.FARM_RESERVE_ADDRESS
      )
        return 'not_farm_wallet';
      const info = await this.chain.algoInfo(address);
      const spendable = info.amount - info.minBalance;
      if (spendable >= cfg.threshold) return 'enough';
      if (
        (await this.sentSince({ address })) + cfg.amount >
        cfg.perWalletDaily
      ) {
        this.log.warn(`Fee top-up wallet cap reached for ${address}`);
        return 'wallet_cap';
      }
      if ((await this.sentSince({})) + cfg.amount > cfg.globalDaily) {
        this.log.warn('Fee top-up global daily cap reached');
        return 'global_cap';
      }
      const funder = await this.chain.algoInfo(this.chain.funderAddress());
      if (funder.amount - cfg.amount < cfg.funderFloor) {
        this.log.error(
          `ALERT: funder ALGO below floor (${Number(funder.amount) / 1e6}); fee top-ups paused`,
        );
        return 'funder_floor';
      }
      let row: any;
      try {
        row = await this.prisma.chain_fee_topups.create({
          data: {
            network: chainConfig().network,
            user_id: w.user_id,
            address,
            micro_algos: cfg.amount,
            spendable_before: spendable,
            reason,
          },
        });
      } catch (e: any) {
        if (e?.code === 'P2002') return 'in_flight';
        throw e;
      }
      try {
        const prep = await this.chain.prepareFund(
          address,
          cfg.amount,
          `farm:feetopup:${row.id}`,
        );
        await this.prisma.chain_fee_topups.update({
          where: { id: row.id },
          data: { tx_id: prep.txId, last_valid: prep.lastValid },
        });
        await prep.send();
        await this.prisma.chain_fee_topups.update({
          where: { id: row.id },
          data: { status: 'sent' },
        });
        this.log.log(`Fee top-up ${prep.txId} -> ${address}`);
        return 'sent';
      } catch (e: any) {
        // Leave the row 'sending' if a txId exists: resolveStuck() asks the
        // chain before anything new is sent for this address.
        const hasTx = await this.prisma.chain_fee_topups.findUnique({
          where: { id: row.id },
        });
        if (!hasTx?.tx_id)
          await this.prisma.chain_fee_topups.update({
            where: { id: row.id },
            data: {
              status: 'failed',
              error: String(e?.message ?? e).slice(0, 300),
            },
          });
        return 'failed';
      }
    } catch (e: any) {
      this.log.warn(
        `Fee top-up check failed for ${address}: ${e?.message ?? e}`,
      );
      return 'failed';
    }
  }

  /** Settle rows left 'sending': confirmed -> sent; expired -> failed. */
  async resolveStuck() {
    const rows = await this.prisma.chain_fee_topups.findMany({
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
      if (st === 'confirmed')
        await this.prisma.chain_fee_topups.update({
          where: { id: r.id },
          data: { status: 'sent' },
        });
      else if (
        !r.tx_id ||
        (r.last_valid != null && round > BigInt(r.last_valid))
      )
        await this.prisma.chain_fee_topups.update({
          where: { id: r.id },
          data: { status: 'failed', error: 'expired unconfirmed' },
        });
    }
  }
}
