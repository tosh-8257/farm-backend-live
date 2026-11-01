import {
  BadRequestException,
  Injectable,
  Optional,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { generateTxReference } from '../common/utils/reference.util';
import { paginate, paginationParams } from '../common/utils/pagination.util';
import { ADMIN_TRANSITIONS, RELEASABLE } from './project-rules';
import { presentProject } from './marketplace.service';
import { FeesService } from '../fees/fees.service';
import { TokenizationService } from '../tokenization/tokenization.service';
import { TokenDeliveryService } from '../tokenization/token-delivery.service';
import {
  chargeConsolidationInTx,
  heldFunds,
  payFromReserveInTx,
  releaseReserveToFarmInTx,
  reserveLeft,
} from './consolidation';

/** Admin-only project review. Nothing here runs automatically. */
@Injectable()
export class ProjectReviewService {
  private readonly logger = new Logger(ProjectReviewService.name);
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly fees?: FeesService,
    @Optional() private readonly tokens?: TokenizationService,
    @Optional() private readonly delivery?: TokenDeliveryService,
  ) {}

  /** Round close: take the consolidation fund fee once (no-op if already taken). */
  private closeRound(projectId: string, by: string) {
    return this.prisma.$transaction((tx) =>
      chargeConsolidationInTx(tx, this.fees, projectId, by),
    );
  }

  async list(q: { status?: string; page?: any; limit?: any }) {
    const { skip, take, page, limit } = paginationParams(q.page, q.limit);
    const where: any = q.status
      ? { status: q.status }
      : { business_id: { not: null } };
    const [rows, total] = await Promise.all([
      this.prisma.investment_projects.findMany({
        where,
        skip,
        take,
        orderBy: [{ submitted_at: 'desc' }, { created_at: 'desc' }],
        include: {
          business: {
            select: { legal_name: true, trading_name: true, status: true },
          },
        },
      }),
      this.prisma.investment_projects.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({
        ...presentProject(r),
        business: r.business,
        review_notes: r.review_notes,
      })),
      meta: paginate(total, page, limit),
    };
  }

  async get(id: string) {
    const p = await this.prisma.investment_projects.findUnique({
      where: { id },
      include: {
        business: {
          select: {
            id: true,
            legal_name: true,
            trading_name: true,
            status: true,
          },
        },
        documents: true,
        milestones: { orderBy: { position: 'asc' } },
        reviews: { orderBy: { created_at: 'desc' } },
      },
    });
    if (!p) throw new NotFoundException('Project not found');
    return {
      data: {
        ...presentProject(p),
        business: p.business,
        documents: p.documents,
        reviews: p.reviews,
        review_notes: p.review_notes,
      },
    };
  }

  async transition(
    adminId: string,
    id: string,
    action: string,
    notes?: string,
  ) {
    const rule = ADMIN_TRANSITIONS[action];
    if (!rule) throw new BadRequestException('Unknown action');
    if (['request_info', 'reject'].includes(action) && !notes?.trim())
      throw new BadRequestException('Notes are required for this action');
    const p = await this.prisma.investment_projects.findUnique({
      where: { id },
      include: { business: { select: { status: true } } },
    });
    if (!p) throw new NotFoundException('Project not found');
    if (!rule.from.includes(p.status ?? ''))
      throw new BadRequestException(
        `Cannot ${action} a project in status ${p.status}`,
      );
    if (
      ['approve', 'list'].includes(action) &&
      p.business_id &&
      p.business?.status !== 'approved'
    )
      throw new BadRequestException(
        'The business must pass KYB before its project can be approved or listed',
      );
    // On-invest token is created together with the listing; failure blocks it.
    if (action === 'list' && this.tokens)
      await this.tokens.ensureTokenForListing(adminId, id);
    const now = new Date();
    const data: any = {
      status: rule.to,
      reviewed_by: adminId,
      review_notes: notes?.trim() || p.review_notes,
    };
    if (action === 'approve') data.approved_at = now;
    if (action === 'list') data.listed_at = now;
    const r = await this.prisma.investment_projects.updateMany({
      where: { id, status: p.status },
      data,
    });
    if (!r.count)
      throw new BadRequestException('Project changed, refresh and try again');
    await this.prisma.project_reviews.create({
      data: {
        project_id: id,
        actor_id: adminId,
        action,
        from_status: p.status,
        to_status: rule.to,
        notes: notes?.trim() || null,
        snapshot: JSON.parse(JSON.stringify(presentProject(p))),
      },
    });
    let consolidation_fee: number | null = null;
    let tokens: any = null;
    if (action === 'close') {
      consolidation_fee = await this.closeRound(id, adminId);
      tokens = (await this.delivery?.closeOnInvest(id)) ?? null;
    }
    let refunds: { refunded: number; amount: number; share: number } | null =
      null;
    if (action === 'cancel') {
      // Tokens first: cancel owed, claw back delivered, then refund FARM.
      tokens = (await this.delivery?.unwindForCancel(id)) ?? null;
      refunds = await this.refundAll(adminId, id);
    }
    return {
      data: { id, status: rule.to, refunds, consolidation_fee, tokens },
    };
  }

  /**
   * Cancelled project: each investor gets back their pro-rata share of
   * (a) the funds still held (not yet released to the business) and
   * (b) what is left of THIS project's consolidation reserve (refundable).
   * The 3% investment fee is never refunded.
   */
  private async refundAll(adminId: string, projectId: string) {
    const p = await this.prisma.investment_projects.findUnique({
      where: { id: projectId },
      select: {
        raised_amount: true,
        released_amount: true,
        consolidation_fee: true,
        consolidation_refunded: true,
        consolidation_released: true,
        consolidation_bought_back: true,
      },
    });
    const raised = Number(p?.raised_amount ?? 0);
    const heldShare = raised > 0 ? Math.min(1, heldFunds(p ?? {}) / raised) : 1;
    const reserveShare = raised > 0 ? reserveLeft(p ?? {}) / raised : 0;
    const share = Math.min(1, heldShare + reserveShare);
    const rows = await this.prisma.user_investments.findMany({
      where: { project_id: projectId, status: { in: ['committed', 'active'] } },
    });
    let done = 0;
    let total = 0;
    let fromReserve = 0;
    for (const inv of rows) {
      // Tokens already sold back were paid from the reserve: not refunded twice.
      const amt = Math.max(
        0,
        Number(inv.amount ?? 0) - Number((inv as any).sold_back_amount ?? 0),
      );
      const heldPart = Math.floor(amt * heldShare * 100) / 100;
      const reservePart = Math.floor(amt * reserveShare * 100) / 100;
      const refund = Number((heldPart + reservePart).toFixed(2));
      await this.prisma.$transaction(async (tx) => {
        const claim = await tx.user_investments.updateMany({
          where: { id: inv.id, status: inv.status },
          data: { status: share >= 1 ? 'refunded' : 'partially_refunded' },
        });
        if (!claim.count || refund <= 0) return;
        const t = await this.creditInvestor(tx, inv, refund, projectId, {
          reason: 'cancelled',
          held_part: heldPart,
          reserve_part: reservePart,
          by: adminId,
        });
        await payFromReserveInTx(tx, projectId, reservePart, t);
        done++;
        total += refund;
        fromReserve += reservePart;
      });
    }
    return {
      refunded: done,
      amount: Number(total.toFixed(2)),
      from_reserve: Number(fromReserve.toFixed(2)),
      share,
    };
  }

  /**
   * Project made a loss (admin-declared, notes required): pay what is left of
   * this project's consolidation reserve to its investors, pro-rata to what
   * each invested. One time per project, all-or-nothing.
   */
  async refundReserveForLoss(
    adminId: string,
    projectId: string,
    notes?: string,
  ) {
    if (!notes?.trim())
      throw new BadRequestException('Notes are required (describe the loss)');
    const p = await this.prisma.investment_projects.findUnique({
      where: { id: projectId },
      select: {
        raised_amount: true,
        consolidation_fee: true,
        consolidation_refunded: true,
        consolidation_released: true,
        consolidation_bought_back: true,
        consolidation_fee_at: true,
        status: true,
      },
    });
    if (!p) throw new NotFoundException('Project not found');
    if (!p.consolidation_fee_at)
      throw new BadRequestException('The funding round has not closed');
    if (Number(p.consolidation_released ?? 0) > 0)
      throw new BadRequestException(
        'The reserve was already released to FARM (project completed)',
      );
    if (Number(p.consolidation_refunded ?? 0) > 0)
      throw new BadRequestException(
        'The consolidation reserve was already refunded',
      );
    const raised = Number(p.raised_amount ?? 0);
    const reserve = reserveLeft(p);
    if (!(reserve > 0) || !(raised > 0))
      throw new BadRequestException('No consolidation reserve to refund');
    const rows = await this.prisma.user_investments.findMany({
      where: {
        project_id: projectId,
        status: { in: ['committed', 'active', 'partially_refunded'] },
      },
    });
    const parts = rows
      .map((inv) => ({
        inv,
        amount:
          Math.floor(
            (Math.max(
              0,
              Number(inv.amount ?? 0) -
                Number((inv as any).sold_back_amount ?? 0),
            ) *
              reserve *
              100) /
              raised,
          ) / 100,
      }))
      .filter((x) => x.amount > 0);
    const total = await this.prisma.$transaction(async (tx) => {
      let sum = 0;
      for (const { inv, amount } of parts) {
        const t = await this.creditInvestor(tx, inv, amount, projectId, {
          reason: 'loss',
          reserve_part: amount,
          notes: notes.trim(),
          by: adminId,
        });
        await payFromReserveInTx(tx, projectId, amount, t);
        sum += amount;
      }
      return Number(sum.toFixed(2));
    });
    await this.prisma.project_reviews.create({
      data: {
        project_id: projectId,
        actor_id: adminId,
        action: 'consolidation_refund_loss',
        from_status: p.status ?? 'funded',
        to_status: p.status ?? 'funded',
        notes: notes.trim(),
      },
    });
    return { data: { refunded: parts.length, amount: total, reserve } };
  }

  /**
   * Project completed successfully (all funds released to the business): the
   * remaining reserve is released to FARM revenue. It stays in the platform
   * wallet; the ledger reclassifies it. Admin-only, notes required, once.
   */
  async releaseReserveToFarm(
    adminId: string,
    projectId: string,
    notes?: string,
  ) {
    if (!notes?.trim())
      throw new BadRequestException('Notes are required (confirm completion)');
    const p = await this.prisma.investment_projects.findUnique({
      where: { id: projectId },
      select: {
        status: true,
        project_name: true,
        raised_amount: true,
        released_amount: true,
        consolidation_fee: true,
        consolidation_refunded: true,
        consolidation_released: true,
        consolidation_bought_back: true,
        consolidation_fee_at: true,
      },
    });
    if (!p) throw new NotFoundException('Project not found');
    if (!p.consolidation_fee_at || !RELEASABLE.includes(p.status ?? ''))
      throw new BadRequestException('The funding round has not closed');
    if (heldFunds(p) > 0.005)
      throw new BadRequestException(
        'All milestones must be released before the project is completed',
      );
    if (Number(p.consolidation_refunded ?? 0) > 0)
      throw new BadRequestException(
        'Investors were already refunded from this reserve',
      );
    const amount = Number(reserveLeft(p).toFixed(8));
    if (!(amount > 0))
      throw new BadRequestException('No consolidation reserve left');
    const txId = await this.prisma.$transaction(async (tx) => {
      const t = await tx.transactions.create({
        data: {
          transaction_reference: generateTxReference(),
          transaction_type: 'fee',
          status: 'completed',
          amount,
          fee: 0,
          net_amount: amount,
          description: `Consolidation reserve released to FARM: ${p.project_name}`,
          metadata: {
            project_id: projectId,
            category: 'consolidation_release',
            by: adminId,
            notes: notes.trim(),
          },
          processed_at: new Date(),
        },
      });
      await releaseReserveToFarmInTx(tx, projectId, amount, t.id);
      return t.id;
    });
    await this.prisma.project_reviews.create({
      data: {
        project_id: projectId,
        actor_id: adminId,
        action: 'consolidation_release_farm',
        from_status: p.status ?? 'closed',
        to_status: p.status ?? 'closed',
        notes: notes.trim(),
      },
    });
    return { data: { amount, transaction_id: txId } };
  }

  private async creditInvestor(
    tx: any,
    inv: { id: string; user_id: string | null },
    amount: number,
    projectId: string,
    meta: Record<string, any>,
  ): Promise<string> {
    const w = await tx.wallets.findFirst({
      where: { user_id: inv.user_id!, is_active: true },
    });
    if (!w)
      throw new BadRequestException(`Investor wallet missing for ${inv.id}`);
    await tx.wallets.update({
      where: { id: w.id },
      data: { balance: { increment: amount } },
    });
    const t = await tx.transactions.create({
      data: {
        transaction_reference: generateTxReference(),
        receiver_wallet_id: w.id,
        transaction_type: 'investment_refund',
        status: 'completed',
        amount,
        fee: 0,
        net_amount: amount,
        description:
          meta.reason === 'loss'
            ? 'Consolidation fund refund (project loss)'
            : 'Investment refund (project cancelled)',
        metadata: { investment_id: inv.id, project_id: projectId, ...meta },
        processed_at: new Date(),
      },
    });
    await tx.ledger_entries.create({
      data: {
        transaction_id: t.id,
        wallet_id: w.id,
        entry_type: 'credit',
        amount,
        description:
          meta.reason === 'loss'
            ? 'Consolidation fund refund'
            : 'Investment refund',
      },
    });
    return t.id;
  }

  /**
   * Release one requested milestone to the business owner's wallet.
   * Admin-only, in order, after the funding round ended. Amount =
   * milestone amount scaled by raised/target, never above what is still held.
   */
  async releaseMilestone(
    adminId: string,
    projectId: string,
    milestoneId: string,
    notes?: string,
  ) {
    const p = await this.prisma.investment_projects.findUnique({
      where: { id: projectId },
      include: {
        business: { select: { owner_user_id: true, status: true } },
        milestones: { orderBy: { position: 'asc' } },
      },
    });
    if (!p) throw new NotFoundException('Project not found');
    if (!RELEASABLE.includes(p.status ?? ''))
      throw new BadRequestException(
        'Milestones can only be released after the funding round has ended',
      );
    if (!p.business?.owner_user_id)
      throw new BadRequestException('Legacy projects have no milestones');
    if (p.business.status !== 'approved')
      throw new BadRequestException('Business is not in good standing (KYB)');
    const m = p.milestones.find((x) => x.id === milestoneId);
    if (!m) throw new NotFoundException('Milestone not found');
    if (m.status !== 'requested')
      throw new BadRequestException(
        'The business has not requested this milestone',
      );
    if (
      p.milestones.some(
        (x) => x.position < m.position && x.status !== 'released',
      )
    )
      throw new BadRequestException(
        'Earlier milestones must be released first',
      );
    const raised = Number(p.raised_amount ?? 0);
    const target = Number(p.target_amount);
    // Round closed: the consolidation fund fee must be taken before any release.
    let cfee = Number(p.consolidation_fee ?? 0);
    if (!p.consolidation_fee_at) {
      await this.closeRound(projectId, adminId);
      const r = await this.prisma.investment_projects.findUnique({
        where: { id: projectId },
        select: { consolidation_fee: true },
      });
      cfee = Number(r?.consolidation_fee ?? 0);
    }
    const net = raised - cfee; // what the business can receive in total
    const held = heldFunds({ ...p, consolidation_fee: cfee });
    const isLast = !p.milestones.some((x) => x.position > m.position);
    let amount =
      Math.floor(Number(m.amount) * Math.min(1, net / target) * 100) / 100;
    if (isLast) amount = held; // last milestone sweeps any rounding remainder
    amount = Math.min(amount, held);
    if (!(amount > 0))
      throw new BadRequestException('No funds left to release');
    const w = await this.prisma.wallets.findFirst({
      where: { user_id: p.business.owner_user_id, is_active: true },
    });
    if (!w) throw new BadRequestException('Business owner wallet not found');

    const txId = await this.prisma.$transaction(async (tx) => {
      const claimM = await tx.project_milestones.updateMany({
        where: { id: m.id, status: 'requested' },
        data: {
          status: 'released',
          released_amount: amount,
          released_at: new Date(),
          released_by: adminId,
          release_notes: notes?.trim() || null,
        },
      });
      if (!claimM.count)
        throw new BadRequestException('Milestone was already handled');
      const claimP = await tx.$executeRaw`
        UPDATE investment_projects
           SET released_amount = released_amount + ${amount}, updated_at = now()
         WHERE id = ${projectId}::uuid
           AND released_amount + ${amount} <= COALESCE(raised_amount, 0) - consolidation_fee`;
      if (claimP !== 1)
        throw new BadRequestException('Release would exceed the funds held');
      await tx.wallets.update({
        where: { id: w.id },
        data: { balance: { increment: amount } },
      });
      const t = await tx.transactions.create({
        data: {
          transaction_reference: generateTxReference(),
          receiver_wallet_id: w.id,
          transaction_type: 'investment_settlement',
          status: 'completed',
          amount,
          fee: 0,
          net_amount: amount,
          description: `Milestone ${m.position} release: ${p.project_name}`,
          metadata: { project_id: projectId, milestone_id: m.id, by: adminId },
          processed_at: new Date(),
        },
      });
      await tx.ledger_entries.create({
        data: {
          transaction_id: t.id,
          wallet_id: w.id,
          entry_type: 'credit',
          amount,
          description: `Milestone ${m.position} ${p.project_name}`,
        },
      });
      await tx.project_milestones.update({
        where: { id: m.id },
        data: { transaction_id: t.id },
      });
      // Funds are now deployed: held investments become active.
      await tx.user_investments.updateMany({
        where: { project_id: projectId, status: 'committed' },
        data: { status: 'active' },
      });
      return t.id;
    });
    await this.prisma.project_reviews.create({
      data: {
        project_id: projectId,
        actor_id: adminId,
        action: 'milestone_released',
        from_status: p.status,
        to_status: p.status ?? 'funded',
        notes: `Milestone ${m.position}: ${amount}${notes ? ` · ${notes}` : ''}`,
      },
    });
    return {
      data: {
        milestone_id: m.id,
        released_amount: amount,
        transaction_id: txId,
      },
    };
  }

  /** Send a milestone request back to the business with notes. */
  async returnMilestone(
    adminId: string,
    projectId: string,
    milestoneId: string,
    notes: string,
  ) {
    if (!notes?.trim()) throw new BadRequestException('Notes are required');
    const r = await this.prisma.project_milestones.updateMany({
      where: { id: milestoneId, project_id: projectId, status: 'requested' },
      data: { status: 'returned', release_notes: notes.trim() },
    });
    if (!r.count)
      throw new BadRequestException('Milestone is not awaiting release');
    await this.prisma.project_reviews.create({
      data: {
        project_id: projectId,
        actor_id: adminId,
        action: 'milestone_returned',
        to_status: 'funded',
        notes: notes.trim(),
      },
    });
    return { data: { id: milestoneId, status: 'returned' } };
  }

  // ---------------- Investor eligibility ----------------

  async listInvestors(q: { status?: string; page?: any; limit?: any }) {
    const { skip, take, page, limit } = paginationParams(q.page, q.limit);
    const where: any = q.status ? { eligibility_status: q.status } : {};
    const [rows, total] = await Promise.all([
      this.prisma.investor_profiles.findMany({
        where,
        skip,
        take,
        orderBy: { updated_at: 'desc' },
      }),
      this.prisma.investor_profiles.count({ where }),
    ]);
    return { data: rows, meta: paginate(total, page, limit) };
  }

  async setEligibility(
    adminId: string,
    userId: string,
    dto: { status: string; category?: string; notes?: string },
  ) {
    if (!['pending', 'eligible', 'restricted'].includes(dto.status))
      throw new BadRequestException('Unknown status');
    if (
      dto.category &&
      !['retail', 'sophisticated', 'institutional'].includes(dto.category)
    )
      throw new BadRequestException('Unknown category');
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const data = {
      eligibility_status: dto.status,
      category: dto.category ?? null,
      notes: dto.notes ?? null,
      reviewed_by: adminId,
      reviewed_at: new Date(),
    };
    const r = await this.prisma.investor_profiles.upsert({
      where: { user_id: userId },
      update: data,
      create: { user_id: userId, ...data },
    });
    return { data: r };
  }
}
