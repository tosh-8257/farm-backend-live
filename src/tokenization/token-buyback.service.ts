import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { generateTxReference } from '../common/utils/reference.util';
import { AlgorandWalletClient } from '../chain-wallet/algorand-wallet.client';
import {
  payBuybackFromReserveInTx,
  reserveLeft,
} from '../project-marketplace/consolidation';
import { AlgorandAsaClient } from './algorand-asa.client';
import { onInvestConfig } from './on-invest';

/** 1 token = 1 FARM (same unit price as tokenization). */
export const BUYBACK_PRICE = 1;
const OPEN = ['requested', 'approved', 'returning'];
const SELLABLE = ['held', 'owed', 'delivered'];
const PROJECT_OK = ['funded', 'closed'];
const HOLDING = ['committed', 'active'];
const r2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;

export const buybackEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.TOKEN_BUYBACK_ENABLED === 'true';

/**
 * Investor sell-back of project tokens, paid from that project's 15%
 * consolidation reserve. Rules:
 *  - Per investor: at most (reserve ratio, i.e. consolidation_fee / raised,
 *    default 15%) of what they invested in the project, cumulative.
 *  - Safety: never more than what is left of the project's reserve
 *    (guarded SQL claim), minus other open requests.
 *  - Over the limit -> rejected (not queued).
 *  - Every buyback needs admin approval (it moves money).
 *  - Delivered tokens are clawed back to the issuer on-chain FIRST; FARM is
 *    credited only after the return confirms. held/owed tokens: DB only.
 */
@Injectable()
export class TokenBuybackService {
  private readonly log = new Logger(TokenBuybackService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly chain: AlgorandWalletClient,
    private readonly asa: AlgorandAsaClient,
  ) {}

  private assertOn() {
    if (!buybackEnabled())
      throw new BadRequestException(
        'Selling tokens back is not switched on yet',
      );
  }

  /** Per-investor allowance + project pool for (user, project). */
  async allowance(userId: string, projectId: string) {
    const p = await this.prisma.investment_projects.findUnique({
      where: { id: projectId },
      select: {
        status: true,
        raised_amount: true,
        consolidation_fee: true,
        consolidation_fee_at: true,
        consolidation_refunded: true,
        consolidation_released: true,
        consolidation_bought_back: true,
      },
    });
    if (!p) throw new NotFoundException('Project not found');
    const raised = Number(p.raised_amount ?? 0);
    const fee = Number(p.consolidation_fee ?? 0);
    const ratio = p.consolidation_fee_at && raised > 0 ? fee / raised : 0;
    const invs = await this.prisma.user_investments.findMany({
      where: {
        user_id: userId,
        project_id: projectId,
        status: { in: HOLDING },
      },
      select: { amount: true, sold_back_amount: true },
    });
    const invested = invs.reduce((s, i) => s + Number(i.amount ?? 0), 0);
    const sold = invs.reduce((s, i) => s + Number(i.sold_back_amount ?? 0), 0);
    const open = await this.prisma.token_buybacks.aggregate({
      where: { user_id: userId, project_id: projectId, status: { in: OPEN } },
      _sum: { amount: true },
    });
    const pending = Number(open._sum?.amount ?? 0);
    const allOpen = await this.prisma.token_buybacks.aggregate({
      where: { project_id: projectId, status: { in: OPEN } },
      _sum: { amount: true },
    });
    const pool = reserveLeft(p);
    const poolFree = Math.max(0, pool - Number(allOpen._sum?.amount ?? 0));
    const cap = r2(invested * ratio);
    const remaining = r2(Math.max(0, cap - sold - pending));
    return {
      open: !!p.consolidation_fee_at && PROJECT_OK.includes(p.status ?? ''),
      percent: Number((ratio * 100).toFixed(2)),
      invested: r2(invested),
      cap,
      sold_back: r2(sold),
      pending: r2(pending),
      remaining,
      pool_left: r2(pool),
      /** What this investor can sell right now (allowance AND pool). */
      available: r2(Math.min(remaining, poolFree)),
    };
  }

  // ---------- Investor ----------
  async request(userId: string, allocationId: string, units: number) {
    this.assertOn();
    if (!Number.isInteger(units) || units < 1)
      throw new BadRequestException('Units must be a whole number above 0');
    const a = await this.prisma.token_allocations.findUnique({
      where: { id: allocationId },
      include: { token: true },
    });
    if (!a || a.user_id !== userId)
      throw new NotFoundException('Token holding not found');
    // Sell-back is tied to the original investment: tokens received by
    // transfer carry no sell-back allowance.
    if (!a.investment_id)
      throw new BadRequestException(
        'Tokens received by transfer cannot be sold back. Only tokens from your own investment can.',
      );
    if (!SELLABLE.includes(a.status))
      throw new BadRequestException('These tokens cannot be sold back now');
    const free = BigInt(a.units) - BigInt(a.sold_units ?? 0);
    if (BigInt(units) > free)
      throw new BadRequestException(`You hold ${free} sellable tokens here`);
    const projectId = a.token.project_id;
    const al = await this.allowance(userId, projectId);
    if (!al.open)
      throw new BadRequestException(
        'Sell-back opens once the project is funded and its 15% fund is in place',
      );
    const amount = units * BUYBACK_PRICE;
    if (amount > al.available)
      throw new BadRequestException(
        al.available < al.remaining
          ? `The project's buyback fund only has ${al.available} FARM left right now`
          : `You can sell back up to ${al.percent}% of what you invested: ${al.available} FARM left`,
      );
    try {
      const row = await this.prisma.token_buybacks.create({
        data: {
          allocation_id: a.id,
          project_id: projectId,
          user_id: userId,
          units: BigInt(units),
          amount,
          from_status: a.status,
        },
      });
      return { data: this.shape(row), message: 'Sent to FARM for approval' };
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new BadRequestException(
          'You already have an open sell-back request for these tokens',
        );
      throw e;
    }
  }

  async mine(userId: string) {
    const rows = await this.prisma.token_buybacks.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    return { data: rows.map((r) => this.shape(r)) };
  }

  // ---------- Admin ----------
  async adminList(status?: string) {
    const rows = await this.prisma.token_buybacks.findMany({
      where: status ? { status } : {},
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    return { data: rows.map((r) => this.shape(r)), enabled: buybackEnabled() };
  }

  /** Pool usage per project with a consolidation fund. */
  async adminPools() {
    const ps = await this.prisma.investment_projects.findMany({
      where: { consolidation_fee_at: { not: null } },
      select: {
        id: true,
        project_name: true,
        status: true,
        raised_amount: true,
        consolidation_fee: true,
        consolidation_refunded: true,
        consolidation_released: true,
        consolidation_bought_back: true,
      },
      orderBy: { consolidation_fee_at: 'desc' },
      take: 200,
    });
    const open = await this.prisma.token_buybacks.groupBy({
      by: ['project_id'],
      where: { status: { in: OPEN } },
      _sum: { amount: true },
    });
    const pend = new Map(
      (open as any[]).map((o) => [o.project_id, Number(o._sum?.amount ?? 0)]),
    );
    return {
      data: ps.map((p) => ({
        project_id: p.id,
        project_name: p.project_name,
        status: p.status,
        raised: Number(p.raised_amount ?? 0),
        fund: Number(p.consolidation_fee ?? 0),
        bought_back: Number(p.consolidation_bought_back ?? 0),
        refunded: Number(p.consolidation_refunded ?? 0),
        released: Number(p.consolidation_released ?? 0),
        pending: pend.get(p.id) ?? 0,
        left: r2(reserveLeft(p)),
      })),
    };
  }

  async reject(adminId: string, id: string, notes: string) {
    if (!notes?.trim()) throw new BadRequestException('Notes are required');
    const r = await this.prisma.token_buybacks.updateMany({
      where: { id, status: { in: ['requested', 'failed'] }, tx_id: null },
      data: { status: 'rejected', notes: notes.trim(), reviewed_by: adminId },
    });
    if (!r.count) throw new BadRequestException('Request is not pending');
    return { data: { id, status: 'rejected' } };
  }

  /** Admin approval: return tokens (if on-chain) then pay FARM. Idempotent. */
  async approve(adminId: string, id: string) {
    this.assertOn();
    const b = await this.prisma.token_buybacks.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Buyback not found');
    if (!['requested', 'failed', 'approved'].includes(b.status))
      throw new BadRequestException(`Buyback is ${b.status}`);
    const claim = await this.prisma.token_buybacks.updateMany({
      where: { id, status: b.status },
      data: { status: 'approved', reviewed_by: adminId, error: null },
    });
    if (!claim.count) throw new BadRequestException('Buyback changed, retry');
    const onChain = b.from_status === 'delivered';
    if (onChain) {
      const ok = await this.returnTokens(id);
      if (!ok)
        throw new ServiceUnavailableException(
          'Token return did not confirm; it will be retried. No FARM was paid.',
        );
    }
    return this.settle(id, 'approved');
  }

  /** Claw `units` back from the investor's wallet to the issuer. */
  private async returnTokens(id: string): Promise<boolean> {
    const b = (await this.prisma.token_buybacks.findUnique({ where: { id } }))!;
    if (b.tx_id) {
      const st = await this.chain.txStatus(b.tx_id);
      if (st === 'confirmed') return true;
      const round = await this.chain.currentRound();
      if (b.last_valid == null || round <= BigInt(b.last_valid)) return false;
      // expired unconfirmed: safe to rebuild
    }
    if (!onInvestConfig().enabled)
      throw new ServiceUnavailableException('Tokenization is switched off');
    const a = await this.prisma.token_allocations.findUnique({
      where: { id: b.allocation_id },
      include: { token: true },
    });
    if (!a?.address || a.token.asset_id == null)
      throw new BadRequestException('Delivered holding has no wallet address');
    let issuer: any;
    try {
      issuer = this.asa.issuerSigner();
      const prep = await this.chain.prepareClawback({
        clawback: issuer,
        from: a.address,
        to: issuer.address,
        assetId: BigInt(a.token.asset_id),
        amount: BigInt(b.units),
        note: `farm:token:buyback:${b.id}`,
      });
      await this.prisma.token_buybacks.update({
        where: { id },
        data: {
          address: a.address,
          tx_id: prep.txId,
          last_valid: prep.lastValid,
        },
      });
      await prep.send();
      return true;
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      this.log.warn(`Buyback ${id} token return failed: ${msg}`);
      await this.prisma.token_buybacks.update({
        where: { id },
        data: { error: msg },
      });
      return false;
    } finally {
      issuer?.wipe?.();
    }
  }

  /**
   * One DB transaction: claim the buyback, re-check the investor allowance,
   * reduce the holding, pay from the project's reserve (guarded), credit the
   * investor. Any failure rolls everything back and marks the row failed.
   */
  async settle(id: string, fromStatus: string) {
    try {
      const out = await this.prisma.$transaction(async (tx) => {
        const c = await tx.token_buybacks.updateMany({
          where: { id, status: fromStatus },
          data: { status: 'paid' },
        });
        if (!c.count) throw new BadRequestException('Buyback already settled');
        const b = (await tx.token_buybacks.findUnique({ where: { id } }))!;
        const amount = Number(b.amount);
        const a = (await tx.token_allocations.findUnique({
          where: { id: b.allocation_id },
        }))!;
        // Investor cap (cumulative), checked again inside the transaction.
        const p = await tx.investment_projects.findUnique({
          where: { id: b.project_id },
          select: { raised_amount: true, consolidation_fee: true },
        });
        const raised = Number(p?.raised_amount ?? 0);
        const ratio =
          raised > 0 ? Number(p?.consolidation_fee ?? 0) / raised : 0;
        const invs = await tx.user_investments.findMany({
          where: {
            user_id: b.user_id,
            project_id: b.project_id,
            status: { in: HOLDING },
          },
          select: { amount: true, sold_back_amount: true },
        });
        const cap = r2(
          invs.reduce((s: number, i: any) => s + Number(i.amount ?? 0), 0) *
            ratio,
        );
        const sold = invs.reduce(
          (s: number, i: any) => s + Number(i.sold_back_amount ?? 0),
          0,
        );
        if (sold + amount > cap + 1e-9)
          throw new BadRequestException(
            'Over the investor sell-back limit (15% of invested)',
          );
        const units = BigInt(b.units);
        const left = BigInt(a.units) - BigInt(a.sold_units ?? 0) - units;
        // Guard: holding still in the expected state with enough units.
        const held = await tx.token_allocations.updateMany({
          where: {
            id: a.id,
            status: b.from_status,
            sold_units: BigInt(a.sold_units ?? 0),
          },
          data: {
            sold_units: { increment: units },
            ...(left <= 0n ? { status: 'sold_back' } : {}),
          },
        });
        if (!a.investment_id || !held.count || left < 0n)
          throw new BadRequestException('Holding changed, retry');
        await tx.user_investments.update({
          where: { id: a.investment_id },
          data: { sold_back_amount: { increment: amount } },
        });
        const w = await tx.wallets.findFirst({
          where: { user_id: b.user_id, is_active: true },
        });
        if (!w) throw new BadRequestException('Investor wallet missing');
        const t = await tx.transactions.create({
          data: {
            transaction_reference: generateTxReference(),
            receiver_wallet_id: w.id,
            transaction_type: 'token_buyback',
            status: 'completed',
            amount,
            fee: 0,
            net_amount: amount,
            description: `Tokens sold back (${units} units)`,
            metadata: {
              buyback_id: id,
              project_id: b.project_id,
              allocation_id: a.id,
              return_tx: b.tx_id,
            },
            processed_at: new Date(),
          },
        });
        if (!(await payBuybackFromReserveInTx(tx, b.project_id, amount, t.id)))
          throw new BadRequestException(
            "The project's buyback fund does not have enough left",
          );
        await tx.wallets.update({
          where: { id: w.id },
          data: { balance: { increment: amount } },
        });
        await tx.ledger_entries.create({
          data: {
            transaction_id: t.id,
            wallet_id: w.id,
            entry_type: 'credit',
            amount,
            description: 'Project tokens sold back',
          },
        });
        await tx.token_buybacks.update({
          where: { id },
          data: { transaction_id: t.id },
        });
        return { id, status: 'paid', amount, transaction_id: t.id };
      });
      return { data: out };
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      await this.prisma.token_buybacks.updateMany({
        where: { id, status: fromStatus },
        data: { status: 'failed', error: msg },
      });
      throw e instanceof BadRequestException
        ? e
        : new ServiceUnavailableException('Buyback failed; you can retry');
    }
  }

  private shape(r: any) {
    return {
      ...r,
      units: r.units?.toString(),
      amount: Number(r.amount),
      last_valid: r.last_valid?.toString() ?? null,
    };
  }
}
