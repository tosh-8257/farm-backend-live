import { Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { AlgorandWalletClient } from '../chain-wallet/algorand-wallet.client';
import { chainConfig, FARM_DECIMALS } from '../chain-wallet/chain-config';
import { sealSecret, walletSigner } from '../chain-wallet/key-vault';
import { AlgoSigner } from '../chain-wallet/signer';
import { NotificationsService } from '../notifications/notifications.service';
import {
  autoPayoutsEnabled,
  fundsCaps,
  killSwitchOn,
} from './funds-flow-rules';

export const toUnits = (farm: number) =>
  BigInt(Math.round(farm * 10 ** FARM_DECIMALS));
const MAX_ATTEMPTS = 5;

/**
 * On-chain side of the project funds flow (PROJECT_AUTO_PAYOUTS_ENABLED).
 *
 * Escrow design: one dedicated custodial Algorand account per project,
 * created like user custodial wallets (seed sealed with
 * WALLET_KEY_ENCRYPTION_KEY, min balance + FARM opt-in paid by the funder,
 * network fees pooled by the funder). It holds the on-chain FARM backing the
 * project's locked funds and undistributed returns. Every DB money movement
 * of the project enqueues one outbox row here; this service sends it:
 * compare-and-set claim, txId stored before sending, resolver for crashes.
 * Users without a ready custodial wallet are backed by the FARM reserve, so
 * their share goes escrow -> reserve (keeps ledger == chain).
 */
@Injectable()
export class ProjectFundsChainService {
  private readonly log = new Logger(ProjectFundsChainService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: AlgorandWalletClient,
    @Optional() private readonly notes?: NotificationsService,
  ) {}

  enabled() {
    return autoPayoutsEnabled() && chainConfig().wallets.enabled;
  }
  private farm() {
    return BigInt(process.env.FARM_ASA_ID!);
  }
  private reserve() {
    return process.env.FARM_RESERVE_ADDRESS!;
  }

  /** Append-only audit row (never throws into the money path). */
  async audit(
    projectId: string | null,
    action: string,
    actor: string | null,
    amount?: number,
    detail?: any,
  ) {
    try {
      await this.prisma.project_funds_audit.create({
        data: {
          project_id: projectId,
          action,
          actor,
          amount: amount ?? null,
          detail: detail ?? undefined,
        },
      });
    } catch (e: any) {
      this.log.error(`audit write failed: ${e?.message ?? e}`);
    }
  }

  /** In-app alert to every super admin. */
  async alertAdmins(title: string, body: string, metadata: any = {}) {
    if (!this.notes) return;
    try {
      const admins = await this.prisma.users.findMany({
        where: { role: 'super_admin', is_deleted: false },
        select: { id: true },
        take: 20,
      });
      for (const a of admins)
        await this.notes.createInApp(a.id, {
          type: 'system',
          title,
          body,
          metadata,
        });
    } catch (e: any) {
      this.log.warn(`admin alert failed: ${e?.message ?? e}`);
    }
  }

  /** Escrow account of a project, created on first use. */
  async escrowFor(projectId: string) {
    let e = await this.prisma.project_escrows.findUnique({
      where: { project_id: projectId },
    });
    if (e) return e;
    const acct = this.chain.newAccount();
    try {
      e = await this.prisma.project_escrows.create({
        data: {
          project_id: projectId,
          network: chainConfig().network,
          address: acct.address,
          key_scheme: acct.scheme,
          ...sealSecret(acct.seed, acct.address),
        },
      });
    } catch {
      e = await this.prisma.project_escrows.findUnique({
        where: { project_id: projectId },
      });
    } finally {
      acct.seed.fill(0);
    }
    return e!;
  }

  /** Fund min balance + opt in to FARM (resumable). */
  async provision(projectId: string) {
    const e = await this.escrowFor(projectId);
    if (e.status === 'ready') return e;
    const c = await this.prisma.project_escrows.updateMany({
      where: { id: e.id, status: { in: ['created', 'failed'] } },
      data: { status: 'provisioning', error: null },
    });
    if (!c.count) return e;
    let sk: AlgoSigner | null = null;
    try {
      const data: Record<string, string> = {};
      if (!e.funded_tx_id)
        data.funded_tx_id = await this.chain.fund(
          e.address,
          BigInt(process.env.CHAIN_WALLET_FUND_MICROALGOS ?? '310000'),
        );
      sk = walletSigner(e);
      if (!e.farm_opt_in_tx)
        data.farm_opt_in_tx = await this.chain.optIn(
          e.address,
          sk,
          this.farm(),
        );
      return await this.prisma.project_escrows.update({
        where: { id: e.id },
        data: { ...data, status: 'ready' },
      });
    } catch (err: any) {
      await this.prisma.project_escrows.update({
        where: { id: e.id },
        data: {
          status: 'failed',
          error: String(err?.message ?? err).slice(0, 300),
        },
      });
      throw err;
    } finally {
      sk?.wipe();
    }
  }

  /** On-chain address that backs a user's FARM balance. */
  async addressOf(userId: string) {
    const w = await this.prisma.user_chain_wallets.findUnique({
      where: { user_id: userId },
    });
    return w?.status === 'ready' ? w.address : this.reserve();
  }

  /** Queue one move. Idempotent by key. No-op when auto payouts are off. */
  async enqueue(m: {
    projectId: string;
    kind: 'fund' | 'spend' | 'return_in' | 'holder' | 'fee';
    refId?: string | null;
    from: 'escrow' | 'reserve' | { userId: string };
    to: 'escrow' | 'reserve' | { userId: string };
    amount: number;
    key: string;
  }) {
    if (!this.enabled()) return null;
    const units = toUnits(m.amount);
    if (units <= 0n) return null;
    const e = await this.escrowFor(m.projectId);
    const addr = async (x: typeof m.from) =>
      x === 'escrow'
        ? e.address
        : x === 'reserve'
          ? this.reserve()
          : this.addressOf(x.userId);
    const from = await addr(m.from);
    const to = await addr(m.to);
    if (from === to) return null; // nothing to move on-chain
    try {
      return await this.prisma.project_chain_moves.create({
        data: {
          project_id: m.projectId,
          kind: m.kind,
          ref_id: m.refId ?? null,
          from_address: from,
          to_address: to,
          units,
          move_key: m.key,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') return null;
      throw err;
    }
  }

  private async signerFor(
    address: string,
    projectId: string,
  ): Promise<AlgoSigner> {
    if (address === this.reserve()) return this.chain.reserveSigner();
    const e = await this.prisma.project_escrows.findUnique({
      where: { project_id: projectId },
    });
    if (e?.address === address) return walletSigner(e);
    const w = await this.prisma.user_chain_wallets.findUnique({
      where: { address },
    });
    if (!w) throw new Error('No signer for source address');
    return walletSigner(w);
  }

  /** Sends pending moves; resolves ones left in "sending". */
  @Interval(30_000)
  async process(limit = 20) {
    if (!this.enabled() || killSwitchOn()) return { sent: 0 };
    const caps = fundsCaps();
    try {
      const fs = this.chain.funder();
      const funderAddr = fs.address;
      fs.wipe();
      const f = await this.chain.algoInfo(funderAddr);
      if (f.amount < caps.funderFloorMicroAlgos) {
        await this.alertAdmins(
          'Project payouts held',
          'Funder ALGO is below the floor; on-chain project moves are waiting.',
        );
        return { sent: 0, held: 'funder_floor' };
      }
    } catch {
      return { sent: 0 };
    }
    await this.resolveSending();
    const rows = await this.prisma.project_chain_moves.findMany({
      where: { status: 'pending' },
      orderBy: { created_at: 'asc' },
      take: limit,
    });
    let sent = 0;
    for (const r of rows) {
      const p = await this.prisma.investment_projects.findUnique({
        where: { id: r.project_id },
        select: { funds_paused: true },
      });
      if (p?.funds_paused) continue;
      const claim = await this.prisma.project_chain_moves.updateMany({
        where: { id: r.id, status: 'pending' },
        data: { status: 'sending', attempts: { increment: 1 } },
      });
      if (!claim.count) continue;
      let sk: AlgoSigner | null = null;
      try {
        const bal = await this.chain.assetBalance(r.from_address, this.farm());
        if (bal < r.units) throw new Error('Source FARM balance too low');
        sk = await this.signerFor(r.from_address, r.project_id);
        const prep = await this.chain.prepareFarmTransfer({
          from: r.from_address,
          signer: sk,
          to: r.to_address,
          assetId: this.farm(),
          amount: r.units,
          note: `farm:project:${r.kind}:${r.id}`,
        });
        await this.prisma.project_chain_moves.update({
          where: { id: r.id },
          data: { tx_id: prep.txId, last_valid: prep.lastValid },
        });
        await prep.send();
        await this.prisma.project_chain_moves.update({
          where: { id: r.id },
          data: { status: 'sent', error: null },
        });
        await this.audit(
          r.project_id,
          `chain_${r.kind}`,
          'system',
          Number(r.units) / 10 ** FARM_DECIMALS,
          { move_id: r.id, tx_id: prep.txId },
        );
        sent++;
      } catch (err: any) {
        const msg = String(err?.message ?? err).slice(0, 300);
        const cur = await this.prisma.project_chain_moves.findUnique({
          where: { id: r.id },
        });
        // txId stored: let the resolver decide. Otherwise retry, then block.
        if (!cur?.tx_id) {
          const blocked = (cur?.attempts ?? 0) >= MAX_ATTEMPTS;
          await this.prisma.project_chain_moves.update({
            where: { id: r.id },
            data: { status: blocked ? 'blocked' : 'pending', error: msg },
          });
          if (blocked)
            await this.alertAdmins(
              'Project on-chain move blocked',
              `${r.kind} move ${r.id} stopped: ${msg}`,
              { move_id: r.id },
            );
        } else {
          await this.prisma.project_chain_moves.update({
            where: { id: r.id },
            data: { error: msg },
          });
        }
      } finally {
        sk?.wipe();
      }
    }
    return { sent };
  }

  /** Crash recovery: confirmed -> sent; expired and unknown -> retry. */
  async resolveSending() {
    const rows = await this.prisma.project_chain_moves.findMany({
      where: {
        status: 'sending',
        tx_id: { not: null },
        updated_at: { lt: new Date(Date.now() - 60_000) },
      },
      take: 50,
    });
    if (!rows.length) return;
    const round = await this.chain.currentRound();
    for (const r of rows) {
      const s = await this.chain.txStatus(r.tx_id!);
      if (s === 'confirmed')
        await this.prisma.project_chain_moves.updateMany({
          where: { id: r.id, status: 'sending' },
          data: { status: 'sent' },
        });
      else if (s === 'unknown' && r.last_valid != null && round > r.last_valid)
        await this.prisma.project_chain_moves.updateMany({
          where: { id: r.id, status: 'sending', tx_id: r.tx_id },
          data: { status: 'pending', tx_id: null, last_valid: null },
        });
    }
  }
}
