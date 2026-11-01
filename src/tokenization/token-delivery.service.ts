import { Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { AlgorandWalletClient } from '../chain-wallet/algorand-wallet.client';
import { FeeTopupService } from '../chain-wallet/fee-topup.service';
import { walletSigner } from '../chain-wallet/key-vault';
import { AlgorandAsaClient } from './algorand-asa.client';
import { MAX_ATTEMPTS, OPT_IN_NEED, onInvestConfig } from './on-invest';

/** Projects whose tokens may be delivered. Cancelled ones are clawed back. */
const DELIVERABLE = ['listed', 'open', 'funded', 'closed'];

/**
 * Delivers on-invest project tokens from the issuer to investors' ready FARM
 * custodial wallets, and claws them back when a project is cancelled.
 *
 * Idempotent outbox: a row is claimed (owed -> sending) with a compare-and-set,
 * the signed txId + lastValid are stored BEFORE sending, and rows left
 * 'sending' are settled by asking the chain (confirmed -> delivered, expired ->
 * owed again). Nothing is ever sent twice for one allocation.
 * Opt-in for in-app wallets is done by the backend; its min-balance ALGO comes
 * only from the capped FeeTopupService (PR #21), never an unlimited fund.
 */
@Injectable()
export class TokenDeliveryService {
  private readonly log = new Logger(TokenDeliveryService.name);
  private busy = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: AlgorandWalletClient,
    private readonly asa: AlgorandAsaClient,
    @Optional() private readonly topup?: FeeTopupService,
  ) {}

  @Interval('farm-token-delivery', 30_000)
  async tick() {
    if (!onInvestConfig().delivery || this.busy) return;
    this.busy = true;
    try {
      await this.resolveStuck();
      await this.retryClawbacks();
      const rows = await this.prisma.token_allocations.findMany({
        where: {
          status: 'owed',
          attempts: { lt: MAX_ATTEMPTS },
          token: {
            mode: 'on_invest',
            status: 'created',
            project: { status: { in: DELIVERABLE } },
          },
        },
        orderBy: { created_at: 'asc' },
        take: 20,
        select: { id: true },
      });
      for (const r of rows) await this.deliverOne(r.id);
    } catch (e: any) {
      this.log.warn(`Token delivery tick failed: ${e?.message ?? e}`);
    } finally {
      this.busy = false;
    }
  }

  /** Returns what happened; never throws. */
  async deliverOne(allocationId: string): Promise<string> {
    const cfg = onInvestConfig();
    if (!cfg.delivery) return 'disabled';
    const a = await this.prisma.token_allocations.findUnique({
      where: { id: allocationId },
      include: { token: { include: { project: true } } },
    });
    if (!a || a.status !== 'owed' || a.token.asset_id == null) return 'skip';
    if (!DELIVERABLE.includes(a.token.project?.status ?? '')) return 'skip';
    const toSend = BigInt(a.units) - BigInt(a.sold_units ?? 0);
    if (toSend <= 0n) return 'skip';
    // Never race an open sell-back of the same holding.
    const openBuyback = await this.prisma.token_buybacks.count({
      where: {
        allocation_id: a.id,
        status: { in: ['requested', 'approved', 'returning'] },
      },
    });
    if (openBuyback) return 'buyback_open';
    const w = await this.prisma.user_chain_wallets.findUnique({
      where: { user_id: a.user_id },
    });
    // No ready in-app wallet on the token's network: stays owed (shown in app).
    if (!w || w.status !== 'ready' || w.network !== a.token.network)
      return 'owed_no_wallet';
    const assetId = BigInt(a.token.asset_id);
    try {
      if (!(await this.chain.isOptedIn(w.address, assetId))) {
        const t = this.topup
          ? await this.topup.ensure(w.address, 'token_optin', OPT_IN_NEED)
          : 'disabled';
        if (t !== 'enough' && t !== 'sent') {
          await this.note(a.id, `waiting for ALGO for opt-in (${t})`);
          return 'owed_no_algo';
        }
        const sk = walletSigner(w);
        try {
          await this.chain.optIn(w.address, sk, assetId);
        } finally {
          sk.wipe();
        }
      }
    } catch (e: any) {
      await this.fail(a.id, `opt-in failed: ${e?.message ?? e}`, false);
      return 'failed';
    }
    const claim = await this.prisma.token_allocations.updateMany({
      where: { id: a.id, status: 'owed' },
      data: {
        status: 'sending',
        address: w.address,
        attempts: { increment: 1 },
        error: null,
      },
    });
    if (!claim.count) return 'in_flight';
    let issuer: any;
    try {
      issuer = this.asa.issuerSigner();
      const prep = await this.chain.prepareFarmTransfer({
        from: issuer.address,
        signer: issuer,
        to: w.address,
        assetId,
        amount: toSend,
        note: `farm:token:${a.id}`,
      });
      await this.prisma.token_allocations.update({
        where: { id: a.id },
        data: { tx_id: prep.txId, last_valid: prep.lastValid },
      });
      await prep.send();
      await this.prisma.token_allocations.update({
        where: { id: a.id },
        data: { status: 'delivered', delivered_at: new Date() },
      });
      return 'delivered';
    } catch (e: any) {
      // txId stored -> leave 'sending' for resolveStuck(); else back to owed.
      const row = await this.prisma.token_allocations.findUnique({
        where: { id: a.id },
      });
      if (!row?.tx_id) await this.fail(a.id, String(e?.message ?? e), true);
      return 'failed';
    } finally {
      issuer?.wipe?.();
    }
  }

  private async note(id: string, msg: string) {
    await this.prisma.token_allocations.update({
      where: { id },
      data: { error: msg.slice(0, 300) },
    });
  }

  private async fail(id: string, msg: string, wasClaimed: boolean) {
    this.log.warn(`Token allocation ${id}: ${msg}`);
    await this.prisma.token_allocations.updateMany({
      where: { id, status: wasClaimed ? 'sending' : 'owed' },
      data: {
        status: 'owed',
        error: msg.slice(0, 300),
        ...(wasClaimed ? {} : { attempts: { increment: 1 } }),
      },
    });
  }

  /** Settle 'sending' and 'clawing' rows from the chain. */
  async resolveStuck() {
    const rows = await this.prisma.token_allocations.findMany({
      where: {
        status: { in: ['sending', 'clawing'] },
        updated_at: { lt: new Date(Date.now() - 60_000) },
      },
      include: { token: { include: { project: true } } },
      take: 50,
    });
    if (!rows.length) return;
    const round = await this.chain.currentRound();
    for (const r of rows) {
      const claw = r.status === 'clawing';
      const txId = claw ? r.clawback_tx_id : r.tx_id;
      const lv = claw ? r.clawback_last_valid : r.last_valid;
      const st = txId ? await this.chain.txStatus(txId) : 'unknown';
      const cancelled = r.token.project?.status === 'cancelled';
      let next: string | null = null;
      if (st === 'confirmed')
        next = claw
          ? 'clawed_back'
          : cancelled
            ? 'clawback_pending'
            : 'delivered';
      else if (!txId || (lv != null && round > BigInt(lv)))
        next = claw ? 'clawback_pending' : cancelled ? 'cancelled' : 'owed';
      if (!next) continue;
      await this.prisma.token_allocations.updateMany({
        where: { id: r.id, status: r.status },
        data: {
          status: next,
          ...(next === 'delivered' ? { delivered_at: new Date() } : {}),
          ...(claw && next === 'clawback_pending'
            ? { clawback_tx_id: null, clawback_last_valid: null }
            : {}),
          ...(!claw && next === 'owed'
            ? { tx_id: null, last_valid: null }
            : {}),
        },
      });
    }
  }

  private async retryClawbacks() {
    const rows = await this.prisma.token_allocations.findMany({
      where: { status: 'clawback_pending' },
      take: 20,
      select: { id: true },
    });
    for (const r of rows) await this.clawOne(r.id);
  }

  /** Claw one delivered allocation back to the issuer. Never throws. */
  async clawOne(id: string): Promise<string> {
    const a = await this.prisma.token_allocations.findUnique({
      where: { id },
      include: { token: true },
    });
    if (!a || a.status !== 'clawback_pending' || !a.address) return 'skip';
    if (!onInvestConfig().enabled || a.token.asset_id == null)
      return 'disabled';
    const claim = await this.prisma.token_allocations.updateMany({
      where: { id, status: 'clawback_pending' },
      data: { status: 'clawing', error: null },
    });
    if (!claim.count) return 'in_flight';
    let issuer: any;
    try {
      issuer = this.asa.issuerSigner();
      const prep = await this.chain.prepareClawback({
        clawback: issuer,
        from: a.address,
        to: issuer.address,
        assetId: BigInt(a.token.asset_id),
        amount: BigInt(a.units) - BigInt(a.sold_units ?? 0),
        note: `farm:token:clawback:${a.id}`,
      });
      await this.prisma.token_allocations.update({
        where: { id },
        data: {
          clawback_tx_id: prep.txId,
          clawback_last_valid: prep.lastValid,
        },
      });
      await prep.send();
      await this.prisma.token_allocations.update({
        where: { id },
        data: { status: 'clawed_back' },
      });
      return 'clawed_back';
    } catch (e: any) {
      const row = await this.prisma.token_allocations.findUnique({
        where: { id },
      });
      if (!row?.clawback_tx_id)
        await this.prisma.token_allocations.update({
          where: { id },
          data: {
            status: 'clawback_pending',
            error: String(e?.message ?? e).slice(0, 300),
          },
        });
      return 'failed';
    } finally {
      issuer?.wipe?.();
    }
  }

  /**
   * Project cancelled (called BEFORE the FARM refund): owed allocations are
   * cancelled, delivered ones are clawed back now (failures are retried by the
   * job), in-flight ones are settled by resolveStuck().
   */
  async unwindForCancel(projectId: string) {
    const t = await this.prisma.project_tokens.findUnique({
      where: { project_id: projectId },
    });
    if (!t || t.mode !== 'on_invest')
      return { cancelled: 0, clawback_queued: 0, clawed_back: 0 };
    const c = await this.prisma.token_allocations.updateMany({
      where: { project_token_id: t.id, status: 'owed' },
      data: { status: 'cancelled' },
    });
    const q = await this.prisma.token_allocations.updateMany({
      where: { project_token_id: t.id, status: 'delivered' },
      data: { status: 'clawback_pending' },
    });
    let done = 0;
    const rows = await this.prisma.token_allocations.findMany({
      where: { project_token_id: t.id, status: 'clawback_pending' },
      select: { id: true },
    });
    for (const r of rows)
      if ((await this.clawOne(r.id)) === 'clawed_back') done++;
    return { cancelled: c.count, clawback_queued: q.count, clawed_back: done };
  }

  /** Round closed: record supply that was never sold; it stays with the issuer. */
  async closeOnInvest(projectId: string) {
    const t = await this.prisma.project_tokens.findUnique({
      where: { project_id: projectId },
    });
    if (!t || t.mode !== 'on_invest' || t.status !== 'created') return null;
    const agg = await this.prisma.token_allocations.aggregate({
      where: {
        project_token_id: t.id,
        status: { notIn: ['cancelled', 'clawed_back'] },
      },
      _sum: { units: true },
    });
    const sold = BigInt(agg._sum?.units ?? 0);
    const unsold = BigInt(t.total_units) - sold;
    await this.prisma.project_tokens.update({
      where: { id: t.id },
      data: { unsold_units: unsold > 0n ? unsold : 0n, closed_at: new Date() },
    });
    return {
      sold: sold.toString(),
      unsold: (unsold > 0n ? unsold : 0n).toString(),
    };
  }
}
