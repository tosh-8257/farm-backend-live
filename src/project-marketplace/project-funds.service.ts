import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { BusinessAccessService } from '../business-ops/business-access.service';
import { AuthService } from '../auth/auth.service';
import { generateTxReference } from '../common/utils/reference.util';
import { creditPlatformInTx } from '../fees/fee-defaults';
import { TokenDistributionService } from '../tokenization/token-distribution.service';
import { EDITABLE, RELEASABLE } from './project-rules';
import { ProjectFundsChainService } from './project-funds-chain.service';
import { settlementWalletFor } from '../business-ops/business-wallet';
import {
  CAPPED_ACTIONS,
  DISTRIBUTION_MODES,
  RETURNS_CATEGORY,
  SPEND_CATEGORY,
  autoPayoutsEnabled,
  fundsCaps,
  fundsFlowEnabled,
  killSwitchOn,
} from './funds-flow-rules';

const r2 = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
const n = (v: any) => Number(v ?? 0);
const OPEN_PROPOSAL = ['requested', 'failed'];
const PAYABLE_INVOICE = ['sent', 'pending', 'overdue'];
const DAY = 86_400_000;

export const monthKey = (d: Date) =>
  `m:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * Project funds flow (PROJECT_FUNDS_FLOW_ENABLED, default off).
 *  - Raised FARM minus the 15% buyback hold is the project's locked balance.
 *  - The business spends it ONLY by paying an invoice or payment link of
 *    another FARM business ("pay from project funds"). No withdrawal to the
 *    owner, no cash out. Optional deliverable tag/note per payment.
 *  - No per-payment approval. Safety rails instead: per-payment cap, daily
 *    cap per project, global daily cap, kill switch, admin pause per project,
 *    idempotency key, audit log and an admin alert on every payout.
 *  - Returns are deposited to the project; per settings the system creates a
 *    pro-rata holder payout (monthly / each deposit / period end, X%) and,
 *    with PROJECT_AUTO_PAYOUTS_ENABLED, pays it automatically minus the 2%
 *    FARM fee. Without that flag the proposal waits for an admin.
 *  - With PROJECT_AUTO_PAYOUTS_ENABLED (TestNet only) every move is mirrored
 *    on-chain through the project's escrow account (ProjectFundsChainService).
 */
@Injectable()
export class ProjectFundsService {
  private readonly log = new Logger(ProjectFundsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessAccessService,
    private readonly auth: AuthService,
    private readonly dist: TokenDistributionService,
    @Optional() private readonly chain?: ProjectFundsChainService,
  ) {}

  private assertOn() {
    if (!fundsFlowEnabled())
      throw new BadRequestException(
        'The project funds flow is not switched on yet',
      );
    if (killSwitchOn())
      throw new ServiceUnavailableException(
        'Project payments are paused platform-wide',
      );
  }

  private async own(
    userId: string,
    projectId: string,
    perm: 'projects:read' | 'projects:manage',
  ) {
    const actor = await this.access.resolve(userId, perm);
    const p = await this.prisma.investment_projects.findFirst({
      where: { id: projectId, business_id: actor.business.id },
      include: { business: { select: { owner_user_id: true } } },
    });
    if (!p) throw new NotFoundException('Project not found');
    return p;
  }

  private audit(
    projectId: string | null,
    action: string,
    actor: string | null,
    amount?: number,
    detail?: any,
  ) {
    return this.chain?.audit(projectId, action, actor, amount, detail);
  }
  private alert(title: string, body: string, meta?: any) {
    return this.chain?.alertAdmins(title, body, meta);
  }

  /** Distribution settings: set while the project is being created/edited. */
  async setSettings(
    userId: string,
    projectId: string,
    dto: {
      distribution_mode: string;
      distribution_percent: number;
      distribution_period_end?: string;
      income_kind?: string;
    },
  ) {
    this.assertOn();
    const p = await this.own(userId, projectId, 'projects:manage');
    if (!EDITABLE.includes(p.status ?? ''))
      throw new BadRequestException(
        'Funds settings are locked once the project is submitted',
      );
    if (
      !(DISTRIBUTION_MODES as readonly string[]).includes(dto.distribution_mode)
    )
      throw new BadRequestException('Unknown distribution mode');
    const pct = Number(dto.distribution_percent);
    if (!(pct >= 0 && pct <= 100))
      throw new BadRequestException('Percent must be 0-100');
    if (dto.distribution_mode !== 'off' && !(pct > 0))
      throw new BadRequestException('Set the share of returns to distribute');
    const end = dto.distribution_period_end
      ? new Date(dto.distribution_period_end)
      : null;
    if (dto.distribution_mode === 'period_end' && (!end || isNaN(+end)))
      throw new BadRequestException('Set the period end date');
    const kind = dto.income_kind === 'rental' ? 'rental' : 'profit';
    await this.prisma.investment_projects.update({
      where: { id: projectId },
      data: {
        distribution_mode: dto.distribution_mode,
        distribution_percent: pct,
        distribution_period_end: end,
        income_kind: kind,
      },
    });
    await this.audit(projectId, 'settings', userId, undefined, {
      mode: dto.distribution_mode,
      pct,
      kind,
    });
    return {
      data: {
        distribution_mode: dto.distribution_mode,
        distribution_percent: pct,
        distribution_period_end: end,
        income_kind: kind,
      },
    };
  }

  // ---------- Spending: pay invoices / payment links from project funds ----------

  /** Caps inside the money transaction (serialised by an advisory lock). */
  private async assertCaps(tx: any, projectId: string, amount: number) {
    const caps = fundsCaps();
    if (amount > caps.perPayment)
      throw new BadRequestException(
        `Project payments are capped at ${caps.perPayment} FARM each`,
      );
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('project_funds_caps'))`;
    const since = new Date(Date.now() - DAY);
    const [proj, all] = await Promise.all([
      tx.project_funds_audit.aggregate({
        where: {
          project_id: projectId,
          action: { in: CAPPED_ACTIONS },
          created_at: { gte: since },
        },
        _sum: { amount: true },
      }),
      tx.project_funds_audit.aggregate({
        where: { action: { in: CAPPED_ACTIONS }, created_at: { gte: since } },
        _sum: { amount: true },
      }),
    ]);
    if (n(proj._sum?.amount) + amount > caps.perProjectDaily)
      throw new BadRequestException(
        `Daily limit for this project is ${caps.perProjectDaily} FARM`,
      );
    if (n(all._sum?.amount) + amount > caps.globalDaily)
      throw new ServiceUnavailableException(
        'Platform daily limit for project payments reached; try tomorrow',
      );
  }

  async spend(
    userId: string,
    projectId: string,
    dto: {
      kind: string;
      ref: string;
      pin: string;
      tag?: string;
      note?: string;
      idempotency_key?: string;
    },
  ) {
    this.assertOn();
    const p = await this.own(userId, projectId, 'projects:manage');
    if (p.funds_paused)
      throw new ForbiddenException(
        `Project payments are paused by FARM${p.funds_paused_reason ? `: ${p.funds_paused_reason}` : ''}`,
      );
    if (!RELEASABLE.includes(p.status ?? '') || !p.consolidation_fee_at)
      throw new BadRequestException(
        'Project funds can be spent once the round has closed',
      );
    if (!dto.pin) throw new BadRequestException('Transaction PIN is required');
    await this.auth.verifyPin(userId, dto.pin);
    const ownerId = p.business?.owner_user_id;

    // Resolve the target: only invoices / payment links of OTHER businesses.
    let target: {
      id: string;
      business_id: string;
      amount: number;
      label: string;
      uses?: number;
    };
    if (dto.kind === 'invoice') {
      const inv = await this.prisma.business_invoices.findUnique({
        where: { invoice_number: dto.ref },
      });
      if (!inv || !PAYABLE_INVOICE.includes(inv.status))
        throw new BadRequestException('Invoice is not payable');
      target = {
        id: inv.id,
        business_id: inv.business_id,
        amount: n(inv.total),
        label: `Invoice ${inv.invoice_number}`,
      };
    } else if (dto.kind === 'payment_link') {
      const l = await this.prisma.business_payment_links.findUnique({
        where: { code: dto.ref },
      });
      const live =
        l &&
        l.is_active &&
        !(l.expires_at && new Date(l.expires_at) <= new Date()) &&
        !(l.max_uses != null && l.use_count >= l.max_uses);
      if (!live) throw new BadRequestException('Payment link is not active');
      target = {
        id: l.id,
        business_id: l.business_id,
        amount: n(l.amount),
        label: `Payment link: ${l.title}`,
        uses: l.use_count,
      };
    } else throw new BadRequestException('Pay an invoice or a payment link');
    const amount = r2(target.amount);
    if (!(amount > 0)) throw new BadRequestException('Nothing to pay');
    if (target.business_id === p.business_id)
      throw new ForbiddenException(
        'Project funds cannot pay your own business',
      );
    const rb = await this.prisma.businesses.findUnique({
      where: { id: target.business_id },
      select: {
        owner_user_id: true,
        status: true,
        trading_name: true,
        legal_name: true,
      },
    });
    if (!rb || rb.status !== 'approved')
      throw new BadRequestException(
        'Recipient is not an approved FARM business',
      );
    if (rb.owner_user_id === ownerId || rb.owner_user_id === userId)
      throw new ForbiddenException(
        'Project funds cannot be paid to the project owner',
      );
    const recipientName = rb.trading_name ?? rb.legal_name ?? 'business';

    const key = dto.idempotency_key
      ? `c:${projectId}:${dto.idempotency_key}`
      : dto.kind === 'invoice'
        ? `invoice:${target.id}`
        : `link:${target.id}:${target.uses}`;
    const prior = await this.prisma.project_spends.findUnique({
      where: { idempotency_key: key },
    });
    if (prior)
      return {
        data: {
          id: prior.id,
          amount: n(prior.amount),
          transaction_reference: prior.transaction_reference,
          status: 'successful',
        },
        message: 'Already paid',
      };

    let out: any;
    try {
      out = await this.prisma.$transaction(async (tx) => {
        await this.assertCaps(tx, projectId, amount);
        // Guarded claim on the locked balance (same column as milestone releases).
        const claimed = await tx.$executeRaw`
          UPDATE investment_projects
             SET released_amount = COALESCE(released_amount, 0) + ${amount}, updated_at = now()
           WHERE id = ${projectId}::uuid
             AND funds_paused = false
             AND consolidation_fee_at IS NOT NULL
             AND COALESCE(released_amount, 0) + ${amount}
                 <= raised_amount - COALESCE(consolidation_fee, 0)`;
        if (claimed !== 1)
          throw new BadRequestException(
            'Not enough project funds for this payment',
          );
        if (dto.kind === 'invoice') {
          const c = await tx.business_invoices.updateMany({
            where: {
              id: target.id,
              status: { in: PAYABLE_INVOICE as any },
              OR: [
                { payment_hold_ref: null },
                { payment_hold_until: { lt: new Date() } },
              ],
            },
            data: { status: 'paid', paid_at: new Date() },
          });
          if (!c.count)
            throw new BadRequestException('Invoice is no longer payable');
        } else {
          const c = await tx.business_payment_links.updateMany({
            where: { id: target.id, is_active: true, use_count: target.uses },
            data: { use_count: { increment: 1 } },
          });
          if (!c.count)
            throw new BadRequestException('Payment link changed; try again');
        }
        // BUSINESS_WALLET_ENABLED: the recipient business's own wallet.
        const w = await settlementWalletFor(tx, {
          ownerUserId: rb.owner_user_id,
        });
        if (!w) throw new BadRequestException('Recipient wallet not found');
        await tx.wallets.update({
          where: { id: w.id },
          data: { balance: { increment: amount } },
        });
        const ref = generateTxReference();
        const t = await tx.transactions.create({
          data: {
            transaction_reference: ref,
            receiver_wallet_id: w.id,
            transaction_type: 'investment_settlement',
            status: 'completed',
            amount,
            fee: 0,
            net_amount: amount,
            description: `${target.label} paid from project ${p.project_name}`,
            metadata: {
              project_id: projectId,
              project_spend: true,
              target_kind: dto.kind,
              target_id: target.id,
              tag: dto.tag ?? null,
            },
            processed_at: new Date(),
          },
        });
        await tx.ledger_entries.create({
          data: {
            transaction_id: t.id,
            wallet_id: w.id,
            entry_type: 'credit',
            amount,
            description: `Project payment: ${p.project_name}`,
            category: SPEND_CATEGORY,
          },
        });
        await tx.business_payments.create({
          data: {
            business_id: target.business_id,
            source: dto.kind === 'invoice' ? 'invoice' : 'payment_link',
            source_id: target.id,
            payer_user_id: userId,
            amount,
            transaction_reference: ref,
            channel: 'project',
          },
        });
        if (dto.kind === 'invoice')
          await tx.business_invoices.update({
            where: { id: target.id },
            data: { transaction_reference: ref },
          });
        const sp = await tx.project_spends.create({
          data: {
            project_id: projectId,
            target_kind: dto.kind,
            target_id: target.id,
            recipient_business_id: target.business_id,
            recipient_user_id: rb.owner_user_id,
            amount,
            tag: dto.tag?.trim().slice(0, 120) || null,
            note: dto.note?.trim().slice(0, 500) || null,
            idempotency_key: key,
            transaction_id: t.id,
            transaction_reference: ref,
            created_by: userId,
          },
        });
        await tx.project_funds_audit.create({
          data: {
            project_id: projectId,
            action: 'spend',
            actor: userId,
            amount,
            detail: {
              spend_id: sp.id,
              to: target.business_id,
              kind: dto.kind,
              ref,
            },
          },
        });
        return sp;
      });
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new BadRequestException('This payment was already made');
      throw e;
    }
    await this.chain?.enqueue({
      projectId,
      kind: 'spend',
      refId: out.id,
      from: 'escrow',
      to: { userId: rb.owner_user_id },
      amount,
      key: `spend:${out.id}`,
    });
    await this.alert(
      'Project payment sent',
      `${p.project_name}: ${amount} FARM to ${recipientName} (${target.label})`,
      { project_id: projectId, spend_id: out.id },
    );
    return {
      data: {
        id: out.id,
        amount,
        transaction_reference: out.transaction_reference,
        recipient: recipientName,
        status: 'successful',
      },
      message: 'Paid from project funds',
    };
  }

  // ---------- Returns ----------

  /** Business deposits returns into the project (debits its FARM wallet). */
  async deposit(
    userId: string,
    projectId: string,
    dto: {
      amount: number;
      transaction_id?: string;
      note?: string;
      pin: string;
    },
  ) {
    this.assertOn();
    const p = await this.own(userId, projectId, 'projects:manage');
    if (!RELEASABLE.includes(p.status ?? ''))
      throw new BadRequestException(
        'Returns can be deposited once the project is funded',
      );
    const amount = Number(dto.amount);
    if (!(amount >= 1) || r2(amount) !== amount)
      throw new BadRequestException(
        'Amount must be at least 1 FARM (2 decimals)',
      );
    if (!dto.pin) throw new BadRequestException('Transaction PIN is required');
    await this.auth.verifyPin(userId, dto.pin);
    const owner = p.business?.owner_user_id;
    if (!owner) throw new BadRequestException('Business owner not found');
    let ret: any;
    try {
      ret = await this.prisma.$transaction(async (tx) => {
        // Returns come from the business wallet (legacy: owner's personal wallet).
        const w = await settlementWalletFor(tx, { ownerUserId: owner });
        if (!w) throw new BadRequestException('Business wallet not found');
        if (dto.transaction_id) {
          // Tag a merchant payment the business received to this project.
          const src = await tx.transactions.findUnique({
            where: { id: dto.transaction_id },
          });
          if (
            !src ||
            src.status !== 'completed' ||
            src.receiver_wallet_id !== w.id
          )
            throw new BadRequestException(
              'Pick a completed payment your business received',
            );
          if (amount > n(src.net_amount ?? src.amount))
            throw new BadRequestException('Amount is more than that payment');
        }
        const took = await tx.wallets.updateMany({
          where: { id: w.id, balance: { gte: amount } },
          data: { balance: { decrement: amount } },
        });
        if (!took.count)
          throw new BadRequestException(`Your wallet needs ${amount} FARM`);
        const t = await tx.transactions.create({
          data: {
            transaction_reference: generateTxReference(),
            sender_wallet_id: w.id,
            transaction_type: 'project_return',
            status: 'completed',
            amount,
            fee: 0,
            net_amount: amount,
            description: `Returns deposited to ${p.project_name}`,
            metadata: {
              project_id: projectId,
              source_transaction_id: dto.transaction_id ?? null,
            },
            processed_at: new Date(),
          },
        });
        await tx.ledger_entries.create({
          data: {
            transaction_id: t.id,
            wallet_id: w.id,
            entry_type: 'debit',
            amount,
            description: `Project returns: ${p.project_name}`,
            category: RETURNS_CATEGORY,
          },
        });
        await creditPlatformInTx(
          tx,
          amount,
          `Project returns held: ${p.project_name}`,
          t.id,
          RETURNS_CATEGORY,
        );
        await tx.investment_projects.update({
          where: { id: projectId },
          data: { returns_deposited: { increment: amount } },
        });
        const row = await tx.project_returns.create({
          data: {
            project_id: projectId,
            amount,
            source: dto.transaction_id ? 'merchant_payment' : 'manual',
            source_transaction_id: dto.transaction_id ?? null,
            note: dto.note?.trim().slice(0, 500) || null,
            deposited_by: userId,
            transaction_id: t.id,
          },
        });
        await tx.project_funds_audit.create({
          data: {
            project_id: projectId,
            action: 'return',
            actor: userId,
            amount,
            detail: { return_id: row.id },
          },
        });
        return row;
      });
    } catch (e: any) {
      if (e?.code === 'P2002')
        throw new BadRequestException(
          'That payment is already tagged to a project',
        );
      throw e;
    }
    await this.chain?.enqueue({
      projectId,
      kind: 'return_in',
      refId: ret.id,
      from: { userId: owner },
      to: 'escrow',
      amount,
      key: `return:${ret.id}`,
    });
    let proposal: any = null;
    if (p.distribution_mode === 'on_deposit' && n(p.distribution_percent) > 0) {
      proposal = await this.proposeFor(
        projectId,
        r2((amount * n(p.distribution_percent)) / 100),
        `r:${ret.id}`,
      );
      if (proposal) await this.autoPay(proposal.id);
    }
    return {
      data: { id: ret.id, amount, proposal_id: proposal?.id ?? null },
      message: proposal
        ? 'Deposited. A holder payout was created.'
        : 'Deposited',
    };
  }

  /** Returns left for new proposals: deposited - distributed - open proposals. */
  async available(projectId: string) {
    const p = await this.prisma.investment_projects.findUnique({
      where: { id: projectId },
      select: { returns_deposited: true, returns_distributed: true },
    });
    const open = await this.prisma.token_distributions.aggregate({
      where: {
        project_id: projectId,
        source: 'project_returns',
        status: { in: OPEN_PROPOSAL },
      },
      _sum: { amount: true },
    });
    return r2(
      Math.max(
        0,
        n(p?.returns_deposited) -
          n(p?.returns_distributed) -
          n(open._sum?.amount),
      ),
    );
  }

  private async proposeFor(projectId: string, wanted: number, key: string) {
    const amount = Math.min(wanted, await this.available(projectId));
    if (!(amount >= 1)) return null;
    const p = await this.prisma.investment_projects.findUnique({
      where: { id: projectId },
      select: { income_kind: true },
    });
    return this.dist.propose(
      projectId,
      amount,
      p?.income_kind ?? 'profit',
      key,
      'Automatic payout from project settings',
    );
  }

  /**
   * Pays a returns proposal automatically when PROJECT_AUTO_PAYOUTS_ENABLED
   * and every rail passes; otherwise it stays requested for an admin.
   */
  async autoPay(distributionId: string) {
    if (!autoPayoutsEnabled()) return { auto: false, reason: 'off' };
    const d = await this.prisma.token_distributions.findUnique({
      where: { id: distributionId },
    });
    if (
      !d ||
      d.source !== 'project_returns' ||
      !OPEN_PROPOSAL.includes(d.status)
    )
      return { auto: false, reason: 'not_open' };
    const p = await this.prisma.investment_projects.findUnique({
      where: { id: d.project_id },
      select: { funds_paused: true, project_name: true },
    });
    if (p?.funds_paused) return { auto: false, reason: 'paused' };
    const amount = n(d.amount);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.assertCaps(tx, d.project_id, amount);
        await tx.project_funds_audit.create({
          data: {
            project_id: d.project_id,
            action: 'distribution',
            actor: 'system',
            amount,
            detail: { distribution_id: d.id },
          },
        });
      });
    } catch (e: any) {
      await this.alert(
        'Project payout held',
        `${p?.project_name}: ${amount} FARM payout waits for an admin (${e?.message ?? e})`,
        { distribution_id: d.id },
      );
      return { auto: false, reason: 'cap' };
    }
    try {
      const r: any = (await this.dist.approve('system', d.id)).data;
      for (const h of r.payouts ?? [])
        await this.chain?.enqueue({
          projectId: d.project_id,
          kind: 'holder',
          refId: d.id,
          from: 'escrow',
          to: { userId: h.user_id },
          amount: h.amount,
          key: `holder:${d.id}:${h.user_id}`,
        });
      if (r.fee > 0)
        await this.chain?.enqueue({
          projectId: d.project_id,
          kind: 'fee',
          refId: d.id,
          from: 'escrow',
          to: 'reserve',
          amount: r.fee,
          key: `fee:${d.id}`,
        });
      await this.alert(
        'Holder payout sent',
        `${p?.project_name}: ${r.paid} FARM to ${r.holders} holders, fee ${r.fee} FARM`,
        { distribution_id: d.id },
      );
      return { auto: true };
    } catch (e: any) {
      // Release the cap reservation; the proposal is marked failed by approve().
      await this.prisma.project_funds_audit.create({
        data: {
          project_id: d.project_id,
          action: 'distribution',
          actor: 'system',
          amount: -amount,
          detail: { distribution_id: d.id, reverted: true },
        },
      });
      await this.alert(
        'Holder payout failed',
        `${p?.project_name}: ${e?.message ?? e}`,
        { distribution_id: d.id },
      );
      return { auto: false, reason: 'failed' };
    }
  }

  /** Hourly: escrow funding, monthly / period-end payouts, retries. */
  @Cron('17 * * * *')
  async tick(now = new Date()) {
    if (!fundsFlowEnabled() || killSwitchOn()) return;
    try {
      const ps = await this.prisma.investment_projects.findMany({
        where: {
          status: { in: RELEASABLE },
          consolidation_fee_at: { not: null },
        },
        select: {
          id: true,
          distribution_mode: true,
          distribution_percent: true,
          distribution_period_end: true,
          raised_amount: true,
          consolidation_fee: true,
          released_amount: true,
          returns_deposited: true,
          returns_distributed: true,
        },
        take: 500,
      });
      for (const p of ps) {
        if (this.chain?.enabled()) {
          try {
            await this.chain.provision(p.id);
            // One-time funding of the escrow with the locked balance at that moment.
            const locked = r2(
              n(p.raised_amount) -
                n(p.consolidation_fee) -
                n(p.released_amount),
            );
            const ret = r2(n(p.returns_deposited) - n(p.returns_distributed));
            await this.chain.enqueue({
              projectId: p.id,
              kind: 'fund',
              from: 'reserve',
              to: 'escrow',
              amount: r2(locked + ret),
              key: `fund:${p.id}`,
            });
          } catch (e: any) {
            await this.alert(
              'Project escrow not ready',
              `Project ${p.id}: ${e?.message ?? e}`,
            );
          }
        }
        const pct = n(p.distribution_percent) / 100;
        if (!(pct > 0)) continue;
        let d: any = null;
        if (p.distribution_mode === 'monthly')
          d = await this.proposeFor(
            p.id,
            r2((await this.available(p.id)) * pct),
            monthKey(now),
          );
        else if (
          p.distribution_mode === 'period_end' &&
          p.distribution_period_end &&
          now >= p.distribution_period_end
        )
          d = await this.proposeFor(
            p.id,
            r2((await this.available(p.id)) * pct),
            'end',
          );
        if (d) await this.autoPay(d.id);
      }
    } catch (e: any) {
      this.log.warn(`Funds flow tick failed: ${e?.message ?? e}`);
    }
  }

  // ---------- Admin rails ----------
  async setPaused(
    adminId: string,
    projectId: string,
    paused: boolean,
    reason?: string,
  ) {
    const c = await this.prisma.investment_projects.updateMany({
      where: { id: projectId },
      data: {
        funds_paused: paused,
        funds_paused_reason: paused
          ? reason?.trim().slice(0, 300) || null
          : null,
      },
    });
    if (!c.count) throw new NotFoundException('Project not found');
    await this.audit(
      projectId,
      paused ? 'pause' : 'resume',
      adminId,
      undefined,
      { reason: reason ?? null },
    );
    return { data: { project_id: projectId, paused } };
  }

  async adminAudit(projectId: string) {
    const [audit, moves] = await Promise.all([
      this.prisma.project_funds_audit.findMany({
        where: { project_id: projectId },
        orderBy: { created_at: 'desc' },
        take: 200,
      }),
      this.prisma.project_chain_moves.findMany({
        where: { project_id: projectId },
        orderBy: { created_at: 'desc' },
        take: 200,
      }),
    ]);
    return {
      data: {
        audit: audit.map((a) => ({
          ...a,
          amount: a.amount == null ? null : n(a.amount),
        })),
        moves: moves.map((m) => ({
          ...m,
          units: m.units.toString(),
          last_valid: m.last_valid?.toString() ?? null,
        })),
        caps: {
          ...fundsCaps(),
          funderFloorMicroAlgos: undefined,
          escrowFloorMicroAlgos: undefined,
        },
        kill_switch: killSwitchOn(),
        auto_payouts: autoPayoutsEnabled(),
      },
    };
  }

  /** Put a blocked on-chain move back in the queue (admin). */
  async retryMove(adminId: string, moveId: string) {
    const c = await this.prisma.project_chain_moves.updateMany({
      where: { id: moveId, status: { in: ['blocked', 'failed'] } },
      data: { status: 'pending', attempts: 0, error: null },
    });
    if (!c.count) throw new BadRequestException('Move is not blocked');
    await this.audit(null, 'retry_move', adminId, undefined, {
      move_id: moveId,
    });
    return { data: { id: moveId, status: 'pending' } };
  }

  // ---------- Timeline ----------
  async ownerTimeline(userId: string, projectId: string) {
    await this.own(userId, projectId, 'projects:read');
    return this.timeline(projectId);
  }

  async investorTimeline(userId: string, projectId: string) {
    const [inv, held] = await Promise.all([
      this.prisma.user_investments.count({
        where: { user_id: userId, project_id: projectId },
      }),
      this.prisma.token_allocations.count({
        where: { user_id: userId, token: { project_id: projectId } },
      }),
    ]);
    if (!inv && !held)
      throw new ForbiddenException(
        'Only investors and token holders can see this',
      );
    return this.timeline(projectId);
  }

  async timeline(projectId: string) {
    const p = await this.prisma.investment_projects.findUnique({
      where: { id: projectId },
      include: { milestones: { orderBy: { position: 'asc' } } },
    });
    if (!p) throw new NotFoundException('Project not found');
    const [spends, returns, dists, escrow] = await Promise.all([
      this.prisma.project_spends.findMany({
        where: { project_id: projectId },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.project_returns.findMany({
        where: { project_id: projectId },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.token_distributions.findMany({
        where: { project_id: projectId },
        orderBy: { created_at: 'asc' },
      }),
      this.prisma.project_escrows.findUnique({
        where: { project_id: projectId },
        select: { address: true, network: true, status: true },
      }),
    ]);
    const ids = [...new Set(spends.map((s) => s.recipient_business_id))];
    const names = new Map(
      (ids.length
        ? await this.prisma.businesses.findMany({
            where: { id: { in: ids } },
            select: { id: true, trading_name: true, legal_name: true },
          })
        : []
      ).map((b) => [b.id, b.trading_name ?? b.legal_name ?? 'Business']),
    );
    const raised = n(p.raised_amount);
    const hold = n(p.consolidation_fee);
    const spent = n(p.released_amount);
    const locked = p.consolidation_fee_at
      ? r2(Math.max(0, raised - hold - spent))
      : 0;
    const events: any[] = [];
    if (p.consolidation_fee_at)
      events.push({
        at: p.consolidation_fee_at,
        type: 'funded',
        amount: raised,
        label: `Raised ${raised} FARM · ${hold} FARM held for buybacks`,
      });
    for (const m of p.milestones)
      if (m.status === 'released')
        events.push({
          at: m.released_at,
          type: 'spent',
          amount: n(m.released_amount),
          label: `Milestone: ${m.title}`,
        });
    for (const s of spends)
      events.push({
        at: s.created_at,
        type: 'spent',
        amount: n(s.amount),
        label: `Paid ${names.get(s.recipient_business_id) ?? 'business'} (${s.target_kind === 'invoice' ? 'invoice' : 'payment link'})`,
        tag: s.tag,
        note: s.note,
        reference: s.transaction_reference,
      });
    for (const r of returns)
      events.push({
        at: r.created_at,
        type: 'return',
        amount: n(r.amount),
        label:
          r.source === 'merchant_payment'
            ? 'Sales / rental payment'
            : (r.note ?? 'Returns deposited'),
      });
    for (const d of dists)
      if (d.status === 'paid')
        events.push({
          at: d.updated_at,
          type: 'distributed',
          amount: n(d.paid_amount),
          fee: n(d.fee),
          label: `${d.kind === 'rental' ? 'Rental' : 'Profit'} paid to ${d.holders ?? 0} holders`,
        });
    events.sort((a, b) => +new Date(a.at) - +new Date(b.at));
    return {
      data: {
        enabled: fundsFlowEnabled(),
        auto_payouts: autoPayoutsEnabled(),
        paused: p.funds_paused,
        summary: {
          raised,
          buyback_hold: hold,
          locked,
          spent,
          returns: n(p.returns_deposited),
          distributed: n(p.returns_distributed),
          returns_available: r2(
            n(p.returns_deposited) - n(p.returns_distributed),
          ),
        },
        settings: {
          distribution_mode: p.distribution_mode,
          distribution_percent: n(p.distribution_percent),
          distribution_period_end: p.distribution_period_end,
          income_kind: p.income_kind,
        },
        escrow: escrow
          ? {
              address: escrow.address,
              network: escrow.network,
              status: escrow.status,
            }
          : null,
        pending_payouts: dists
          .filter((d) => d.status === 'requested')
          .map((d) => ({
            id: d.id,
            amount: n(d.amount),
            period_key: d.period_key,
          })),
        events,
      },
    };
  }
}
