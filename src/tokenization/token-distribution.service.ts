import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from '../business-ops/business-access.service';
import { generateTxReference } from '../common/utils/reference.util';
import { AlgorandWalletClient } from '../chain-wallet/algorand-wallet.client';

export const distributionsEnabled = (env: NodeJS.ProcessEnv = process.env) =>
  env.TOKEN_DISTRIBUTIONS_ENABLED === 'true';

/** Platform fee on distributions. 0 for now (decision pending). */
export const DISTRIBUTION_FEE = 0;

/** DB holdings that count at the snapshot (not on-chain yet). */
const DB_HELD = ['held', 'owed'];
/** States that make a snapshot ambiguous: wait until they settle. */
const IN_FLIGHT = ['sending', 'clawing', 'incoming'];
const KINDS = ['profit', 'rental'];
const r2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;

export type Holder = { user_id: string; units: bigint };

/** Pro-rata split, rounded down to 0.01 FARM. Dust stays with the business. */
export function splitProRata(amount: number, holders: Holder[]) {
  const total = holders.reduce((s, h) => s + h.units, 0n);
  if (total <= 0n)
    return { total, rows: [] as (Holder & { amount: number })[] };
  const rows = holders
    .filter((h) => h.units > 0n)
    .map((h) => ({
      ...h,
      amount: r2((amount * Number(h.units)) / Number(total)),
    }))
    .filter((h) => h.amount > 0);
  return { total, rows };
}

/**
 * Profit / rental income for token holders. The business (or an admin on its
 * behalf) requests a distribution in FARM; an admin approves; the backend
 * takes a snapshot of current holders and, in ONE DB transaction, debits the
 * business owner's FARM wallet and credits each holder pro-rata, recording a
 * payout row per holder. Idempotent: the row is claimed requested -> paid with
 * a compare-and-set and payouts are unique per (distribution, user).
 *
 * Snapshot: delivered holders by their on-chain ASA balance (in-app wallet),
 * held/owed holders by DB units (minus sold-back). The issuer wallet (unsold
 * and returned tokens) is never counted: only users' in-app wallets are read. Snapshots are refused while any token
 * move is in flight, so nothing is counted twice.
 */
@Injectable()
export class TokenDistributionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
    private readonly chain: AlgorandWalletClient,
  ) {}

  private assertOn() {
    if (!distributionsEnabled())
      throw new BadRequestException(
        'Holder income payouts are not switched on yet',
      );
  }

  private async projectWithToken(projectId: string, businessId?: string) {
    const p = await this.prisma.investment_projects.findFirst({
      where: {
        id: projectId,
        ...(businessId ? { business_id: businessId } : {}),
      },
      include: { token: true, business: true },
    });
    if (!p) throw new NotFoundException('Project not found');
    if (!p.token || p.token.status !== 'created' || p.token.asset_id == null)
      throw new BadRequestException('This project has no live token yet');
    if (p.status === 'cancelled')
      throw new BadRequestException('This project was cancelled');
    return p;
  }

  private async create(
    by: string,
    p: any,
    dto: { amount: number; kind?: string; description?: string },
  ) {
    this.assertOn();
    const amount = Number(dto.amount);
    if (!(amount >= 1) || r2(amount) !== amount)
      throw new BadRequestException(
        'Amount must be at least 1 FARM (2 decimals)',
      );
    const kind = dto.kind ?? 'profit';
    if (!KINDS.includes(kind))
      throw new BadRequestException('Kind must be profit or rental');
    const row = await this.prisma.token_distributions.create({
      data: {
        project_id: p.id,
        project_token_id: p.token.id,
        kind,
        amount,
        fee: DISTRIBUTION_FEE,
        description: dto.description?.trim().slice(0, 500) || null,
        requested_by: by,
      },
    });
    return { data: this.shape(row), message: 'Sent to FARM for approval' };
  }

  async businessRequest(userId: string, projectId: string, dto: any) {
    const actor = await this.access.resolve(userId, 'projects:manage');
    const p = await this.projectWithToken(projectId, actor.business.id);
    return this.create(userId, p, dto);
  }

  async adminCreate(adminId: string, projectId: string, dto: any) {
    const p = await this.projectWithToken(projectId);
    return this.create(adminId, p, dto);
  }

  async businessList(userId: string, projectId: string) {
    const actor = await this.access.resolve(userId, 'projects:manage');
    const own = await this.prisma.investment_projects.count({
      where: { id: projectId, business_id: actor.business.id },
    });
    if (!own) throw new NotFoundException('Project not found');
    const rows = await this.prisma.token_distributions.findMany({
      where: { project_id: projectId },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    return {
      data: rows.map((r) => this.shape(r)),
      enabled: distributionsEnabled(),
    };
  }

  async adminList(status?: string) {
    const rows = await this.prisma.token_distributions.findMany({
      where: status ? { status } : {},
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    return {
      data: rows.map((r) => this.shape(r)),
      enabled: distributionsEnabled(),
    };
  }

  /** Holder payout history. */
  async mine(userId: string) {
    const rows = await this.prisma.token_distribution_payouts.findMany({
      where: { user_id: userId },
      include: { distribution: true },
      orderBy: { created_at: 'desc' },
      take: 200,
    });
    const names = new Map(
      (
        await this.prisma.investment_projects.findMany({
          where: {
            id: {
              in: [...new Set(rows.map((r) => r.distribution.project_id))],
            },
          },
          select: { id: true, project_name: true },
        })
      ).map((p) => [p.id, p.project_name]),
    );
    return {
      data: rows.map((r) => ({
        id: r.id,
        distribution_id: r.distribution_id,
        project_id: r.distribution.project_id,
        project_name: names.get(r.distribution.project_id) ?? null,
        kind: r.distribution.kind,
        units: r.units.toString(),
        amount: Number(r.amount),
        transaction_id: r.transaction_id,
        paid_at: r.created_at,
      })),
    };
  }

  async reject(adminId: string, id: string, notes: string) {
    if (!notes?.trim()) throw new BadRequestException('Notes are required');
    const r = await this.prisma.token_distributions.updateMany({
      where: { id, status: { in: ['requested', 'failed'] } },
      data: { status: 'rejected', notes: notes.trim(), reviewed_by: adminId },
    });
    if (!r.count) throw new BadRequestException('Distribution is not pending');
    return { data: { id, status: 'rejected' } };
  }

  /** Current holders of a token (see class doc). */
  async snapshot(tokenId: string, assetId: bigint): Promise<Holder[]> {
    const inFlight = await this.prisma.token_allocations.count({
      where: { project_token_id: tokenId, status: { in: IN_FLIGHT } },
    });
    if (inFlight)
      throw new ServiceUnavailableException(
        'Some tokens are moving right now; try again in a few minutes',
      );
    const rows = await this.prisma.token_allocations.findMany({
      where: {
        project_token_id: tokenId,
        status: { in: [...DB_HELD, 'delivered'] },
      },
      select: { user_id: true, units: true, sold_units: true, status: true },
    });
    const by = new Map<string, bigint>();
    const onChain = new Set<string>();
    for (const r of rows) {
      if (r.status === 'delivered') {
        onChain.add(r.user_id);
        continue;
      }
      const u = BigInt(r.units) - BigInt(r.sold_units ?? 0);
      if (u > 0n) by.set(r.user_id, (by.get(r.user_id) ?? 0n) + u);
    }
    if (onChain.size) {
      const ws = await this.prisma.user_chain_wallets.findMany({
        where: { user_id: { in: [...onChain] } },
        select: { user_id: true, address: true },
      });
      for (const w of ws) {
        const bal = await this.chain.assetBalance(w.address, assetId);
        if (bal > 0n) by.set(w.user_id, (by.get(w.user_id) ?? 0n) + bal);
      }
    }
    return [...by.entries()].map(([user_id, units]) => ({ user_id, units }));
  }

  /** Admin approval: snapshot + pay everyone in one transaction. */
  async approve(adminId: string, id: string) {
    this.assertOn();
    const d = await this.prisma.token_distributions.findUnique({
      where: { id },
    });
    if (!d) throw new NotFoundException('Distribution not found');
    if (!['requested', 'failed'].includes(d.status))
      throw new BadRequestException(`Distribution is ${d.status}`);
    const p = await this.projectWithToken(d.project_id);
    const holders = await this.snapshot(
      p.token!.id,
      BigInt(p.token!.asset_id!),
    );
    const amount = Number(d.amount);
    const { total, rows } = splitProRata(amount, holders);
    if (!rows.length) throw new BadRequestException('No token holders to pay');
    const paid = r2(rows.reduce((s, r) => s + r.amount, 0));
    const fee = Number(d.fee ?? 0);
    const owner = p.business?.owner_user_id;
    if (!owner) throw new BadRequestException('Business owner not found');
    try {
      const out = await this.prisma.$transaction(async (tx) => {
        const c = await tx.token_distributions.updateMany({
          where: { id, status: d.status },
          data: { status: 'paid', reviewed_by: adminId, error: null },
        });
        if (!c.count)
          throw new BadRequestException('Distribution already handled');
        const bw = await tx.wallets.findFirst({
          where: { user_id: owner, is_active: true },
        });
        if (!bw) throw new BadRequestException('Business wallet not found');
        const debit = r2(paid + fee);
        const took = await tx.wallets.updateMany({
          where: { id: bw.id, balance: { gte: debit } },
          data: { balance: { decrement: debit } },
        });
        if (!took.count)
          throw new BadRequestException(
            `The business wallet needs ${debit} FARM for this payout`,
          );
        const dt = await tx.transactions.create({
          data: {
            transaction_reference: generateTxReference(),
            sender_wallet_id: bw.id,
            transaction_type: 'token_distribution',
            status: 'completed',
            amount: debit,
            fee,
            net_amount: paid,
            description: `Holder ${d.kind} payout (${rows.length} holders)`,
            metadata: { distribution_id: id, project_id: d.project_id },
            processed_at: new Date(),
          },
        });
        await tx.ledger_entries.create({
          data: {
            transaction_id: dt.id,
            wallet_id: bw.id,
            entry_type: 'debit',
            amount: debit,
            description: 'Token holder payout',
            category: 'token_distribution',
          },
        });
        for (const h of rows) {
          const w = await tx.wallets.findFirst({
            where: { user_id: h.user_id, is_active: true },
          });
          if (!w)
            throw new BadRequestException(
              `Holder wallet missing (${h.user_id})`,
            );
          await tx.wallets.update({
            where: { id: w.id },
            data: { balance: { increment: h.amount } },
          });
          const t = await tx.transactions.create({
            data: {
              transaction_reference: generateTxReference(),
              receiver_wallet_id: w.id,
              transaction_type: 'token_distribution',
              status: 'completed',
              amount: h.amount,
              fee: 0,
              net_amount: h.amount,
              description: `${d.kind === 'rental' ? 'Rental' : 'Profit'} income (${h.units} tokens)`,
              metadata: { distribution_id: id, project_id: d.project_id },
              processed_at: new Date(),
            },
          });
          await tx.ledger_entries.create({
            data: {
              transaction_id: t.id,
              wallet_id: w.id,
              entry_type: 'credit',
              amount: h.amount,
              description: 'Token holder income',
              category: 'token_distribution',
            },
          });
          await tx.token_distribution_payouts.create({
            data: {
              distribution_id: id,
              user_id: h.user_id,
              units: h.units,
              amount: h.amount,
              transaction_id: t.id,
            },
          });
        }
        await tx.token_distributions.update({
          where: { id },
          data: {
            total_units: total,
            paid_amount: paid,
            holders: rows.length,
            snapshot_at: new Date(),
            debit_transaction_id: dt.id,
          },
        });
        return {
          id,
          status: 'paid',
          paid,
          holders: rows.length,
          total_units: total.toString(),
        };
      });
      return { data: out };
    } catch (e: any) {
      await this.prisma.token_distributions.updateMany({
        where: { id, status: d.status },
        data: {
          status: 'failed',
          error: String(e?.message ?? e).slice(0, 300),
        },
      });
      throw e;
    }
  }

  private shape(r: any) {
    return {
      ...r,
      amount: Number(r.amount),
      fee: Number(r.fee ?? 0),
      paid_amount: r.paid_amount != null ? Number(r.paid_amount) : null,
      total_units: r.total_units?.toString() ?? null,
    };
  }
}
