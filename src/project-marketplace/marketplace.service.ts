import { allocateOnInvestInTx } from '../tokenization/on-invest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { FeesService } from '../fees/fees.service';
import { creditPlatformInTx, feeFor, ruleFor } from '../fees/fee-defaults';
import { chargeConsolidationInTx } from './consolidation';
import { PrismaService } from '../database/prisma.service';
import { AuthService } from '../auth/auth.service';
import { NotificationsService } from '../notifications/notifications.service';
import { generateTxReference } from '../common/utils/reference.util';
import { paginate, paginationParams } from '../common/utils/pagination.util';
import {
  ELIGIBILITY_RULE,
  INVESTABLE,
  MARKET_VISIBLE,
  RISK_DISCLOSURE_TEXT,
  RISK_DISCLOSURE_VERSION,
  SECTORS,
  stripReturns,
} from './project-rules';

const n = (v: any) => (v == null ? null : Number(v));

/** Shape a project for investors: numbers as numbers, never any return/ROI field. */
export function presentProject(p: any, extra: Record<string, any> = {}) {
  const target = Number(p.target_amount ?? 0);
  const raised = Number(p.raised_amount ?? 0);
  const out = stripReturns({
    ...p,
    status: p.status === 'open' ? 'listed' : p.status,
    target_amount: target,
    raised_amount: raised,
    minimum_investment: n(p.minimum_investment),
    maximum_investment: n(p.maximum_investment),
    funding_progress: target > 0 ? Math.min(100, (raised / target) * 100) : 0,
    sector:
      p.sector ?? (p.category ? String(p.category).toLowerCase() : 'other'),
    legacy: !p.business_id,
    ...extra,
  });
  delete out.business;
  delete out.review_notes;
  delete out.reviewed_by;
  delete out.users;
  return out;
}

@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger(MarketplaceService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly notifications: NotificationsService,
    @Optional() private readonly fees?: FeesService,
  ) {}

  sectors() {
    return { data: SECTORS };
  }

  disclosure() {
    return {
      data: { version: RISK_DISCLOSURE_VERSION, points: RISK_DISCLOSURE_TEXT },
    };
  }

  async list(q: {
    sector?: string;
    search?: string;
    status?: string;
    page?: any;
    limit?: any;
  }) {
    const { skip, take, page, limit } = paginationParams(q.page, q.limit);
    const status =
      q.status === 'all'
        ? MARKET_VISIBLE
        : q.status === 'funded'
          ? ['funded']
          : INVESTABLE;
    const where: any = { status: { in: status } };
    if (q.sector && q.sector !== 'all') where.sector = q.sector;
    if (q.search)
      where.OR = [
        { project_name: { contains: q.search, mode: 'insensitive' } },
        { summary: { contains: q.search, mode: 'insensitive' } },
        { location: { contains: q.search, mode: 'insensitive' } },
      ];
    const [rows, total] = await Promise.all([
      this.prisma.investment_projects.findMany({
        where,
        skip,
        take,
        orderBy: [{ listed_at: 'desc' }, { created_at: 'desc' }],
        include: {
          business: { select: { trading_name: true, legal_name: true } },
        },
      }),
      this.prisma.investment_projects.count({ where }),
    ]);
    return {
      data: rows.map((p) =>
        presentProject(p, {
          business_name:
            p.business?.trading_name || p.business?.legal_name || null,
        }),
      ),
      meta: paginate(total, page, limit),
    };
  }

  /** Legacy `projects` table (pre-V2). Readable only, never investable. */
  async legacyList() {
    const rows = await this.prisma.projects.findMany({
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    return {
      data: rows.map((p: any) =>
        stripReturns({
          ...JSON.parse(JSON.stringify(p)),
          legacy: true,
          investable: false,
        }),
      ),
    };
  }

  async detail(id: string, userId?: string) {
    const p = await this.prisma.investment_projects.findUnique({
      where: { id },
      include: {
        business: {
          select: { trading_name: true, legal_name: true, country: true },
        },
        documents: { orderBy: { created_at: 'asc' } },
        updates: { orderBy: { created_at: 'desc' }, take: 20 },
        milestones: {
          orderBy: { position: 'asc' },
          select: {
            position: true,
            title: true,
            description: true,
            amount: true,
            status: true,
            released_amount: true,
            released_at: true,
          },
        },
      },
    });
    if (!p || !MARKET_VISIBLE.includes(p.status ?? ''))
      throw new NotFoundException('Project not found');
    const isInvestor = userId
      ? (await this.prisma.user_investments.count({
          where: { user_id: userId, project_id: id },
        })) > 0
      : false;
    const docs = p.documents
      .filter(
        (d) =>
          d.visibility === 'public' ||
          (d.visibility === 'investors' && (isInvestor || !!userId)),
      )
      .map((d) => ({
        id: d.id,
        kind: d.kind,
        title: d.title,
        url: d.url,
        created_at: d.created_at,
      }));
    return {
      data: presentProject(
        {
          ...p,
          documents: undefined,
          updates: undefined,
          milestones: undefined,
        },
        {
          business_name:
            p.business?.trading_name || p.business?.legal_name || null,
          documents: docs,
          updates: p.updates,
          released_amount: Number(p.released_amount ?? 0),
          consolidation_fee: Number(p.consolidation_fee ?? 0),
          consolidation_reserve:
            Number(p.consolidation_fee ?? 0) -
            Number(p.consolidation_refunded ?? 0) -
            Number(p.consolidation_released ?? 0) -
            Number(p.consolidation_bought_back ?? 0),
          milestones: p.milestones.map((m) => ({
            ...m,
            amount: Number(m.amount),
            released_amount:
              m.released_amount == null ? null : Number(m.released_amount),
          })),
          investable:
            INVESTABLE.includes(p.status ?? '') &&
            (!p.ends_at || p.ends_at > new Date()),
          disclosure: {
            version: RISK_DISCLOSURE_VERSION,
            points: RISK_DISCLOSURE_TEXT,
          },
          fees: await this.investorFees(),
        },
      ),
    };
  }

  /** Live fee terms shown to investors before they invest. */
  async investorFees() {
    const inv = await ruleFor(this.fees, 'investment');
    const cons = await ruleFor(this.fees, 'project_listing');
    return {
      investment_percent: inv.percent,
      consolidation_percent: cons.percent,
      points: [
        `A ${inv.percent}% investment fee is added on top of the amount you invest. It is not refunded, even if the project is cancelled.`,
        `When the funding round closes, ${cons.percent}% of the total raised is held by FARM as this project's consolidation fund (a reserve, like insurance). It is not mixed with other projects' reserves.`,
        `If the project is cancelled or makes a loss, you get your share of this reserve back, plus (if cancelled) your share of any funds not yet released to the business. If the project completes successfully, the reserve is kept by FARM.`,
      ],
    };
  }

  // ---------------- Eligibility ----------------

  async eligibility(userId: string) {
    const [profile, user] = await Promise.all([
      this.prisma.investor_profiles.findUnique({ where: { user_id: userId } }),
      this.prisma.users.findUnique({
        where: { id: userId },
        select: { kyc_status: true },
      }),
    ]);
    // Approved rule: any KYC-verified user may invest unless an admin restricted them.
    let status = 'pending';
    let reason: string | null = null;
    if (profile?.eligibility_status === 'restricted') {
      status = 'restricted';
      reason = 'Your account cannot invest right now. Contact support.';
    } else if (user?.kyc_status === 'verified') status = 'eligible';
    else reason = 'Verify your identity (KYC) before investing.';
    return {
      data: {
        status,
        eligible: status === 'eligible',
        reason,
        category: profile?.category ?? null,
        kyc_status: user?.kyc_status ?? 'none',
        rule: ELIGIBILITY_RULE,
      },
    };
  }

  /** Creates an investor profile record (eligibility itself follows KYC). */
  async requestEligibility(userId: string) {
    await this.prisma.investor_profiles.upsert({
      where: { user_id: userId },
      update: {},
      create: { user_id: userId, eligibility_status: 'pending' },
    });
    return this.eligibility(userId);
  }

  // ---------------- Investing ----------------

  async invest(
    userId: string,
    projectId: string,
    dto: {
      amount: number;
      pin: string;
      accept_risk?: boolean;
      disclosure_version?: string;
    },
    ip?: string,
  ) {
    const amount = Number(dto.amount);
    if (!Number.isFinite(amount) || amount <= 0)
      throw new BadRequestException('Amount must be positive');
    const el = (await this.eligibility(userId)).data;
    if (!el.eligible)
      throw new ForbiddenException(
        el.reason ?? 'You are not eligible to invest yet',
      );
    if (
      dto.accept_risk !== true ||
      dto.disclosure_version !== RISK_DISCLOSURE_VERSION
    )
      throw new BadRequestException(
        'Please read and accept the latest risk disclosure before investing (update the app if you do not see it).',
      );
    await this.auth.verifyPin(userId, dto.pin);

    const project = await this.prisma.investment_projects.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new NotFoundException('Project not found');
    if (!INVESTABLE.includes(project.status ?? ''))
      throw new BadRequestException('Project is not open for investment');
    if (project.ends_at && new Date() > project.ends_at)
      throw new BadRequestException('Investment period has ended');
    if (
      project.minimum_investment &&
      amount < Number(project.minimum_investment)
    )
      throw new BadRequestException(
        `Minimum investment is ${Number(project.minimum_investment)} FARM`,
      );
    const prior = await this.prisma.user_investments.aggregate({
      where: {
        user_id: userId,
        project_id: projectId,
        status: { in: ['committed', 'active'] },
      },
      _sum: { amount: true },
    });
    const already = Number(prior._sum.amount ?? 0);
    if (
      project.maximum_investment &&
      already + amount > Number(project.maximum_investment)
    )
      throw new BadRequestException(
        `Maximum per investor is ${Number(project.maximum_investment)} FARM`,
      );

    const wallet = await this.prisma.wallets.findFirst({
      where: { user_id: userId, is_active: true },
    });
    if (!wallet) throw new NotFoundException('Wallet not found');

    const acceptance = await this.prisma.risk_disclosure_acceptances.create({
      data: {
        user_id: userId,
        project_id: projectId,
        version: RISK_DISCLOSURE_VERSION,
        ip: ip?.slice(0, 64),
      },
    });

    // Marketplace fee (default 3%) is added on top of each investment.
    const fee = await feeFor(this.fees, 'investment', amount);
    const totalDebit = Number((amount + fee).toFixed(2));
    const result = await this.prisma.$transaction(async (tx) => {
      // Atomic capacity claim: never oversubscribe, only while still investable.
      const claimed = await tx.$executeRaw`
        UPDATE investment_projects
           SET raised_amount = COALESCE(raised_amount,0) + ${amount},
               total_backers = COALESCE(total_backers,0) + ${already > 0 ? 0 : 1},
               updated_at = now()
         WHERE id = ${projectId}::uuid
           AND status IN ('listed','open')
           AND COALESCE(raised_amount,0) + ${amount} <= target_amount`;
      if (claimed !== 1)
        throw new ConflictException(
          'Not enough room left in this project for that amount',
        );
      // Atomic debit: funds move into platform custody until the admin settles the round.
      const debited = await tx.$executeRaw`
        UPDATE wallets SET balance = balance - ${totalDebit}, updated_at = now()
         WHERE id = ${wallet.id}::uuid AND balance - COALESCE(locked_balance,0) >= ${totalDebit}`;
      if (debited !== 1) throw new BadRequestException('Insufficient balance');
      const txn = await tx.transactions.create({
        data: {
          transaction_reference: generateTxReference(),
          sender_wallet_id: wallet.id,
          transaction_type: 'investment',
          status: 'completed',
          amount,
          fee,
          net_amount: amount,
          description: `Investment: ${project.project_name}`,
          metadata: {
            user_id: userId,
            project_id: projectId,
            custody: 'platform',
            disclosure: acceptance.id,
          },
          processed_at: new Date(),
        },
      });
      await tx.ledger_entries.create({
        data: {
          transaction_id: txn.id,
          wallet_id: wallet.id,
          entry_type: 'debit',
          amount: totalDebit,
          description:
            fee > 0
              ? `Investment in ${project.project_name} (incl. ${fee} FARM fee)`
              : `Investment in ${project.project_name}`,
        },
      });
      if (fee > 0) {
        await creditPlatformInTx(
          tx,
          fee,
          `Investment fee: ${project.project_name}`,
          txn.id,
        );
      }
      const inv = await tx.user_investments.create({
        data: {
          user_id: userId,
          project_id: projectId,
          amount,
          transaction_id: txn.id,
          status: 'committed',
          disclosure_acceptance_id: acceptance.id,
        },
      });
      // On-invest tokens: record the owed allocation in the same transaction.
      await allocateOnInvestInTx(tx, {
        projectId,
        investmentId: inv.id,
        userId,
        amount,
      });
      const after = await tx.investment_projects.findUnique({
        where: { id: projectId },
        select: { raised_amount: true, target_amount: true },
      });
      if (after && Number(after.raised_amount) >= Number(after.target_amount)) {
        await tx.investment_projects.update({
          where: { id: projectId },
          data: { status: 'funded' },
        });
        // Round closed by reaching its target: take the consolidation fund fee once.
        await chargeConsolidationInTx(tx, this.fees, projectId);
      }
      return inv;
    });

    this.notifications
      .sendNotification(userId, {
        type: 'investment_made',
        title: 'Investment received',
        body: `You invested ${amount} FARM in ${project.project_name}. Investments carry risk and returns are not guaranteed.`,
        entityId: result.id,
        metadata: { investment_id: result.id, project_id: projectId, amount },
      })
      .catch((e) => this.logger.error('Investment notification failed', e));

    return {
      data: stripReturns({ ...result, amount: Number(result.amount) }),
      message: 'Investment recorded',
    };
  }

  // ---------------- Portfolio ----------------

  async portfolio(userId: string) {
    const rows = await this.prisma.user_investments.findMany({
      where: { user_id: userId },
      orderBy: { invested_at: 'desc' },
      include: {
        investment_projects: {
          select: {
            id: true,
            project_name: true,
            sector: true,
            category: true,
            status: true,
            banner_image: true,
            business_id: true,
            target_amount: true,
            raised_amount: true,
          },
        },
      },
    });
    const byProject = new Map<string, any>();
    for (const r of rows) {
      if (!r.project_id || r.status === 'refunded') continue;
      const h = byProject.get(r.project_id) ?? {
        project: presentProject(r.investment_projects ?? { id: r.project_id }),
        invested: 0,
        count: 0,
        status: r.status,
      };
      h.invested += Number(r.amount);
      h.count += 1;
      byProject.set(r.project_id, h);
    }
    const holdings = [...byProject.values()];
    let legacy: any[];
    try {
      legacy = await this.prisma.project_investments.findMany({
        where: { user_id: userId },
        include: { project: { select: { title: true } } },
      });
    } catch {
      legacy = [];
    }
    return {
      data: {
        total_invested: holdings.reduce((s, h) => s + h.invested, 0),
        holdings,
        legacy_records: legacy.map((l: any) =>
          stripReturns({ ...l, amount: n(l.amount_paid), legacy: true }),
        ),
      },
    };
  }

  async history(userId: string, q: { page?: any; limit?: any }) {
    const { skip, take, page, limit } = paginationParams(q.page, q.limit);
    const where = { user_id: userId };
    const [rows, total] = await Promise.all([
      this.prisma.user_investments.findMany({
        where,
        skip,
        take,
        orderBy: { invested_at: 'desc' },
        include: {
          investment_projects: { select: { project_name: true, sector: true } },
        },
      }),
      this.prisma.user_investments.count({ where }),
    ]);
    return {
      data: rows.map((r) => stripReturns({ ...r, amount: Number(r.amount) })),
      meta: paginate(total, page, limit),
    };
  }

  async investorDocuments(userId: string) {
    const ids = (
      await this.prisma.user_investments.findMany({
        where: { user_id: userId },
        select: { project_id: true },
        distinct: ['project_id'],
      })
    )
      .map((r) => r.project_id)
      .filter(Boolean) as string[];
    const docs = await this.prisma.project_documents.findMany({
      where: {
        project_id: { in: ids },
        visibility: { in: ['public', 'investors'] },
      },
      orderBy: { created_at: 'desc' },
      include: { project: { select: { project_name: true } } },
    });
    return { data: docs };
  }

  async investorUpdates(userId: string) {
    const ids = (
      await this.prisma.user_investments.findMany({
        where: { user_id: userId },
        select: { project_id: true },
        distinct: ['project_id'],
      })
    )
      .map((r) => r.project_id)
      .filter(Boolean) as string[];
    const ups = await this.prisma.project_updates.findMany({
      where: { project_id: { in: ids } },
      orderBy: { created_at: 'desc' },
      take: 100,
      include: { project: { select: { project_name: true } } },
    });
    return { data: ups };
  }
}
