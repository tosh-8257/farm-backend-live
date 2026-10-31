import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
} from '@nestjs/common';
import { MarketplaceService, presentProject } from './marketplace.service';
import {
  BusinessProjectsService,
  cleanProjectInput,
} from './business-projects.service';
import { ProjectReviewService } from './project-review.service';
import { RISK_DISCLOSURE_VERSION } from './project-rules';
import { ProjectsService } from '../projects/projects.service';
import { can } from '../business-ops/permissions';
import { chargeConsolidationInTx, heldFunds } from './consolidation';

const PID = '11111111-1111-1111-1111-111111111111';
const listed = {
  id: PID,
  project_name: 'Solar farm',
  status: 'listed',
  target_amount: 1000,
  raised_amount: 0,
  minimum_investment: 10,
  maximum_investment: null,
  roi_percent: 12,
  ends_at: null,
  business_id: 'b1',
};

function marketMocks(over: any = {}) {
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    transactions: { create: jest.fn().mockResolvedValue({ id: 't1' }) },
    ledger_entries: { create: jest.fn() },
    users: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'admin', wallets: [{ id: 'pw' }] }),
    },
    wallets: {
      findUnique: jest.fn().mockResolvedValue({ id: 'pw', balance: 0 }),
      update: jest.fn(),
    },
    user_investments: {
      create: jest
        .fn()
        .mockResolvedValue({ id: 'i1', amount: 100, expected_roi: 5 }),
    },
    investment_projects: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ raised_amount: 100, target_amount: 1000 }),
      update: jest.fn(),
    },
    project_tokens: { findUnique: jest.fn().mockResolvedValue(null) },
    ...over.tx,
  };
  const prisma: any = {
    investor_profiles: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          'profile' in over ? over.profile : { eligibility_status: 'eligible' },
        ),
      upsert: jest.fn(),
    },
    users: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ kyc_status: over.kyc ?? 'verified' }),
    },
    investment_projects: {
      findUnique: jest.fn().mockResolvedValue(over.project ?? listed),
    },
    user_investments: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { amount: over.already ?? 0 } }),
    },
    wallets: { findFirst: jest.fn().mockResolvedValue({ id: 'w1' }) },
    risk_disclosure_acceptances: {
      create: jest.fn().mockResolvedValue({ id: 'r1' }),
    },
    $transaction: jest.fn((fn: any) => fn(tx)),
  };
  const auth: any = { verifyPin: jest.fn().mockResolvedValue(true) };
  const notif: any = {
    sendNotification: jest.fn().mockResolvedValue(undefined),
  };
  return { svc: new MarketplaceService(prisma, auth, notif), prisma, tx, auth };
}
const good = {
  amount: 100,
  pin: '1234',
  accept_risk: true,
  disclosure_version: RISK_DISCLOSURE_VERSION,
};

describe('Phase 4 – no guaranteed returns', () => {
  it('strips ROI fields and maps legacy open to listed', () => {
    const p = presentProject({
      ...listed,
      status: 'open',
      expected_roi: 3,
      roi_percentage: 9,
    });
    expect(p).not.toHaveProperty('roi_percent');
    expect(p).not.toHaveProperty('roi_percentage');
    expect(p).not.toHaveProperty('expected_roi');
    expect(p.status).toBe('listed');
  });
  it('invest response has no expected_roi', async () => {
    const { svc } = marketMocks();
    const r = await svc.invest('u1', PID, good);
    expect(r.data).not.toHaveProperty('expected_roi');
  });
});

describe('Phase 4 – invest gates', () => {
  const OLD = process.env.INVESTOR_ELIGIBILITY_MODE;
  afterEach(() => (process.env.INVESTOR_ELIGIBILITY_MODE = OLD));

  it('any KYC-verified user can invest; unverified KYC is blocked before PIN/debit', async () => {
    expect(
      (await marketMocks({ profile: null }).svc.eligibility('u1')).data
        .eligible,
    ).toBe(true);
    const { svc, auth, prisma } = marketMocks({
      profile: null,
      kyc: 'pending',
    });
    await expect(svc.invest('u1', PID, good)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(auth.verifyPin).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('restricted investors cannot invest even with KYC', async () => {
    expect(
      (
        await marketMocks({
          profile: { eligibility_status: 'restricted' },
        }).svc.eligibility('u1')
      ).data.eligible,
    ).toBe(false);
  });
  it('no per-investor retail cap: a large commitment within project limits goes through', async () => {
    const { svc, prisma } = marketMocks({
      profile: null,
      project: { ...listed, target_amount: 1_000_000 },
      already: 500_000,
    });
    await svc.invest('u1', PID, { ...good, amount: 400_000 });
    expect(prisma.$transaction).toHaveBeenCalled();
  });
  it('requires accepting the current risk disclosure', async () => {
    const { svc, prisma } = marketMocks();
    await expect(
      svc.invest('u1', PID, { ...good, accept_risk: false }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.invest('u1', PID, { ...good, disclosure_version: 'old' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.invest('u1', PID, { amount: 100, pin: '1234' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rejects projects that are not listed', async () => {
    const { svc } = marketMocks({ project: { ...listed, status: 'approved' } });
    await expect(svc.invest('u1', PID, good)).rejects.toThrow('not open');
  });
  it('enforces per-investor maximum', async () => {
    const { svc } = marketMocks({
      project: { ...listed, maximum_investment: 150 },
      already: 100,
    });
    await expect(svc.invest('u1', PID, good)).rejects.toThrow('Maximum');
  });
  it('never oversubscribes: capacity claim failure aborts before debit', async () => {
    const { svc, tx } = marketMocks({
      tx: { $executeRaw: jest.fn().mockResolvedValueOnce(0) },
    });
    await expect(svc.invest('u1', PID, good)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.user_investments.create).not.toHaveBeenCalled();
  });
  it('insufficient balance aborts (whole transaction rolls back)', async () => {
    const { svc, tx } = marketMocks({
      tx: {
        $executeRaw: jest
          .fn()
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(0),
      },
    });
    await expect(svc.invest('u1', PID, good)).rejects.toThrow('Insufficient');
    expect(tx.user_investments.create).not.toHaveBeenCalled();
  });
  it('happy path records disclosure, debits atomically and stores a committed investment', async () => {
    const { svc, tx, prisma } = marketMocks();
    await svc.invest('u1', PID, good, '1.2.3.4');
    expect(prisma.risk_disclosure_acceptances.create).toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.user_investments.create.mock.calls[0][0].data).toMatchObject({
      status: 'committed',
      disclosure_acceptance_id: 'r1',
    });
  });
  it('adds the 3% marketplace fee on top and credits it to the platform wallet', async () => {
    const { svc, tx } = marketMocks();
    await svc.invest('u1', PID, good, '1.2.3.4');
    const t = tx.transactions.create.mock.calls[0][0].data;
    expect(t.amount).toBe(good.amount);
    expect(t.fee).toBeCloseTo(good.amount * 0.03, 2);
    expect(tx.wallets.update).toHaveBeenCalledWith({
      where: { id: 'pw' },
      data: { balance: { increment: t.fee } },
    });
  });
});

describe('Phase 4 – business projects', () => {
  it('validates input and never spreads unknown fields', () => {
    expect(() => cleanProjectInput({ sector: 'casino' } as any)).toThrow();
    expect(() => cleanProjectInput({ target_amount: -1 })).toThrow();
    const d = cleanProjectInput({
      project_name: ' Farm ',
      sector: 'agriculture',
      status: 'listed',
      raised_amount: 9,
    } as any);
    expect(d).toEqual({
      project_name: 'Farm',
      sector: 'agriculture',
      category: 'agriculture',
    });
  });

  function bizMocks(project: any) {
    const prisma: any = {
      investment_projects: {
        findFirst: jest.fn().mockResolvedValue(project),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      project_reviews: { create: jest.fn() },
    };
    const access: any = {
      resolve: jest
        .fn()
        .mockResolvedValue({ business: { id: 'b1' }, role: 'owner' }),
    };
    return { svc: new BusinessProjectsService(prisma, access), prisma, access };
  }
  const full = {
    ...listed,
    status: 'draft',
    sector: 'energy',
    summary: 's',
    description: 'd',
    use_of_funds: 'u',
    risk_factors: 'r',
    instrument_type: 'equity',
    location: 'Nakuru',
    documents: [{ kind: 'business_plan' }, { kind: 'financial_statements' }],
    updates: [],
    reviews: [],
    milestones: [
      { id: 'm1', position: 1, amount: 400, status: 'planned' },
      { id: 'm2', position: 2, amount: 600, status: 'planned' },
    ],
  };
  it('submit requires the mandatory documents', async () => {
    const { svc } = bizMocks({
      ...full,
      documents: [{ kind: 'business_plan' }],
    });
    await expect(svc.submit('u', PID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('submit requires milestones that add up to the target', async () => {
    await expect(
      bizMocks({ ...full, milestones: [] }).svc.submit('u', PID),
    ).rejects.toThrow('incomplete');
    await expect(
      bizMocks({
        ...full,
        milestones: [{ id: 'm1', position: 1, amount: 10 }],
      }).svc.submit('u', PID),
    ).rejects.toThrow('incomplete');
  });
  it('milestones are locked after submit and released in order', async () => {
    await expect(
      bizMocks({ ...full, status: 'submitted' }).svc.setMilestones('u', PID, [
        { title: 'a', amount: 1000 },
      ]),
    ).rejects.toThrow('locked');
    const funded = { ...full, status: 'funded' };
    await expect(
      bizMocks(funded).svc.requestMilestone('u', PID, 'm2', {
        evidence: 'done',
      }),
    ).rejects.toThrow('Earlier');
    await expect(
      bizMocks({ ...full, status: 'listed' }).svc.requestMilestone(
        'u',
        PID,
        'm1',
        { evidence: 'done' },
      ),
    ).rejects.toThrow('funding round');
  });
  it('submit moves to under review and logs it; never auto-approves', async () => {
    const { svc, prisma } = bizMocks(full);
    const r = await svc.submit('u', PID);
    expect(r.data.status).toBe('submitted');
    expect(
      prisma.investment_projects.updateMany.mock.calls[0][0].data.status,
    ).toBe('submitted');
    expect(prisma.project_reviews.create).toHaveBeenCalled();
  });
  it('requires projects:manage (KYB-approved business resolved by access service)', async () => {
    const { svc, access } = bizMocks(full);
    await svc.submit('u', PID);
    expect(access.resolve).toHaveBeenCalledWith('u', 'projects:manage');
    expect(can('finance', 'projects:manage')).toBe(false);
    expect(can('owner', 'projects:manage')).toBe(true);
  });
});

describe('Phase 4 – admin review', () => {
  function revMocks(p: any) {
    const prisma: any = {
      investment_projects: {
        findUnique: jest.fn().mockResolvedValue(p),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      project_reviews: { create: jest.fn() },
      user_investments: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return { svc: new ProjectReviewService(prisma), prisma };
  }
  it('cannot list a project that was not approved', async () => {
    const { svc } = revMocks({
      ...listed,
      status: 'submitted',
      business: { status: 'approved' },
    });
    await expect(svc.transition('a', PID, 'list')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
  it('cannot approve when the business failed KYB', async () => {
    const { svc } = revMocks({
      ...listed,
      status: 'submitted',
      business: { status: 'under_review' },
    });
    await expect(svc.transition('a', PID, 'approve')).rejects.toThrow('KYB');
  });
  it('reject needs notes; approve writes an audit row', async () => {
    const { svc, prisma } = revMocks({
      ...listed,
      status: 'submitted',
      business: { status: 'approved' },
    });
    await expect(svc.transition('a', PID, 'reject')).rejects.toThrow('Notes');
    await svc.transition('a', PID, 'approve');
    expect(prisma.project_reviews.create.mock.calls[0][0].data).toMatchObject({
      action: 'approve',
      to_status: 'approved',
    });
  });
});

describe('Phase 4 – milestone releases (admin only, backend logic)', () => {
  const base = {
    ...listed,
    status: 'funded',
    target_amount: 1000,
    raised_amount: 800,
    released_amount: 0,
    consolidation_fee: 0,
    consolidation_fee_at: new Date(),
    business: { owner_user_id: 'owner', status: 'approved' },
    milestones: [
      { id: 'm1', position: 1, amount: 400, status: 'requested' },
      { id: 'm2', position: 2, amount: 600, status: 'planned' },
    ],
  };
  function relMocks(p: any, claim = 1) {
    const tx: any = {
      project_milestones: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      $executeRaw: jest.fn().mockResolvedValue(claim),
      wallets: { update: jest.fn() },
      transactions: { create: jest.fn().mockResolvedValue({ id: 'tx1' }) },
      ledger_entries: { create: jest.fn() },
      user_investments: { updateMany: jest.fn() },
    };
    const prisma: any = {
      investment_projects: { findUnique: jest.fn().mockResolvedValue(p) },
      wallets: { findFirst: jest.fn().mockResolvedValue({ id: 'w1' }) },
      project_reviews: { create: jest.fn() },
      project_milestones: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn((fn: any) => fn(tx)),
    };
    return { svc: new ProjectReviewService(prisma), prisma, tx };
  }
  it('releases the milestone pro-rata to what was raised, with a real transaction + ledger entry', async () => {
    const { svc, tx } = relMocks(base);
    const r = await svc.releaseMilestone('admin', PID, 'm1');
    expect(r.data).toEqual({
      milestone_id: 'm1',
      released_amount: 320,
      transaction_id: 'tx1',
    });
    expect(tx.wallets.update.mock.calls[0][0].data.balance.increment).toBe(320);
    expect(tx.transactions.create.mock.calls[0][0].data.transaction_type).toBe(
      'investment_settlement',
    );
    expect(tx.ledger_entries.create).toHaveBeenCalled();
    expect(tx.user_investments.updateMany.mock.calls[0][0].data.status).toBe(
      'active',
    );
  });
  it('the last milestone releases exactly the remaining held funds', async () => {
    const p = {
      ...base,
      released_amount: 320,
      milestones: [
        { ...base.milestones[0], status: 'released' },
        { ...base.milestones[1], status: 'requested' },
      ],
    };
    expect(
      (await relMocks(p).svc.releaseMilestone('admin', PID, 'm2')).data
        .released_amount,
    ).toBe(480);
  });
  it('refuses out-of-order, unrequested, pre-funding and over-release', async () => {
    await expect(
      relMocks({
        ...base,
        milestones: [
          { ...base.milestones[0], status: 'planned' },
          { ...base.milestones[1], status: 'requested' },
        ],
      }).svc.releaseMilestone('a', PID, 'm2'),
    ).rejects.toThrow('Earlier');
    await expect(
      relMocks({
        ...base,
        milestones: [{ ...base.milestones[0], status: 'planned' }],
      }).svc.releaseMilestone('a', PID, 'm1'),
    ).rejects.toThrow('not requested');
    await expect(
      relMocks({ ...base, status: 'listed' }).svc.releaseMilestone(
        'a',
        PID,
        'm1',
      ),
    ).rejects.toThrow('funding round');
    await expect(
      relMocks(base, 0).svc.releaseMilestone('a', PID, 'm1'),
    ).rejects.toThrow('exceed');
  });
  it('return needs notes', async () => {
    await expect(
      relMocks(base).svc.returnMilestone('a', PID, 'm1', ' '),
    ).rejects.toThrow('Notes');
    expect(
      (
        await relMocks(base).svc.returnMilestone(
          'a',
          PID,
          'm1',
          'more evidence',
        )
      ).data.status,
    ).toBe('returned');
  });
  it('the old lump-sum settle is gone', () => {
    expect((ProjectReviewService.prototype as any).settle).toBeUndefined();
  });
});

describe('Phase 4 – legacy projects API', () => {
  it('create and invest are gone (old invest never charged the wallet)', () => {
    const svc = new ProjectsService({} as any);
    expect(() => svc.create({}, 'u')).toThrow(GoneException);
    expect(() => svc.invest('u', {}, '')).toThrow(GoneException);
  });
});

describe('Consolidation fund (once at round close, 15% of raised, refundable per-project reserve)', () => {
  function ctx(p: any, claim = 1) {
    const tx: any = {
      investment_projects: {
        findUnique: jest.fn().mockResolvedValue(p),
        updateMany: jest.fn().mockResolvedValue({ count: claim }),
      },
      users: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ wallets: [{ id: 'platform' }] }),
      },
      wallets: {
        findUnique: jest.fn().mockResolvedValue({ id: 'platform', balance: 0 }),
        update: jest.fn(),
      },
      transactions: { create: jest.fn().mockResolvedValue({ id: 'ct1' }) },
      ledger_entries: { create: jest.fn() },
    };
    return tx;
  }
  const prev = process.env.FEE_PROJECT_LISTING_PCT;
  afterAll(() => {
    if (prev === undefined) delete process.env.FEE_PROJECT_LISTING_PCT;
    else process.env.FEE_PROJECT_LISTING_PCT = prev;
  });
  it('takes 15% of the total raised into the main platform wallet, category consolidation_fund', async () => {
    delete process.env.FEE_PROJECT_LISTING_PCT;
    const tx = ctx({
      raised_amount: 800,
      consolidation_fee_at: null,
      project_name: 'P',
    });
    expect(await chargeConsolidationInTx(tx, null, PID)).toBe(120);
    expect(
      tx.investment_projects.updateMany.mock.calls[0][0].where
        .consolidation_fee_at,
    ).toBeNull();
    expect(tx.transactions.create.mock.calls[0][0].data.metadata.category).toBe(
      'consolidation_fund',
    );
    expect(tx.wallets.update.mock.calls[0][0]).toEqual({
      where: { id: 'platform' },
      data: { balance: { increment: 120 } },
    });
    expect(tx.ledger_entries.create.mock.calls[0][0].data.category).toBe(
      'consolidation_fund',
    );
  });
  it('is taken only once (already charged, or lost the race)', async () => {
    const done = ctx({ raised_amount: 800, consolidation_fee_at: new Date() });
    expect(await chargeConsolidationInTx(done, null, PID)).toBe(0);
    expect(done.wallets.update).not.toHaveBeenCalled();
    const race = ctx({ raised_amount: 800, consolidation_fee_at: null }, 0);
    expect(await chargeConsolidationInTx(race, null, PID)).toBe(0);
    expect(race.wallets.update).not.toHaveBeenCalled();
  });
  it('held funds exclude the fee and releases', () => {
    expect(
      heldFunds({
        raised_amount: 800,
        consolidation_fee: 120,
        released_amount: 272,
      }),
    ).toBe(408);
  });
  it('milestones release from the 85% left after the fee', async () => {
    const p: any = {
      ...listed,
      status: 'funded',
      target_amount: 1000,
      raised_amount: 800,
      released_amount: 0,
      consolidation_fee: 120,
      consolidation_fee_at: new Date(),
      business: { owner_user_id: 'owner', status: 'approved' },
      milestones: [
        { id: 'm1', position: 1, amount: 400, status: 'requested' },
        { id: 'm2', position: 2, amount: 600, status: 'planned' },
      ],
    };
    const tx: any = {
      project_milestones: {
        update: jest.fn(),

        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      wallets: { update: jest.fn() },
      transactions: { create: jest.fn().mockResolvedValue({ id: 'tx1' }) },
      ledger_entries: { create: jest.fn() },
      user_investments: { updateMany: jest.fn() },
    };
    const mk = (proj: any) =>
      new ProjectReviewService({
        investment_projects: { findUnique: jest.fn().mockResolvedValue(proj) },
        wallets: { findFirst: jest.fn().mockResolvedValue({ id: 'w1' }) },
        project_reviews: { create: jest.fn() },
        $transaction: jest.fn((fn: any) => fn(tx)),
      } as any);
    expect(
      (await mk(p).releaseMilestone('a', PID, 'm1')).data.released_amount,
    ).toBe(272);
    const p2 = {
      ...p,
      released_amount: 272,
      milestones: [
        { ...p.milestones[0], status: 'released' },
        { ...p.milestones[1], status: 'requested' },
      ],
    };
    expect(
      (await mk(p2).releaseMilestone('a', PID, 'm2')).data.released_amount,
    ).toBe(408);
  });
  function refundCtx(proj: any, invs: any[]) {
    const tx: any = {
      user_investments: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      wallets: {
        findFirst: jest.fn().mockResolvedValue({ id: 'iw' }),
        update: jest.fn(),
      },
      users: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ wallets: [{ id: 'platform', balance: 1000 }] }),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      transactions: { create: jest.fn().mockResolvedValue({ id: 'r1' }) },
      ledger_entries: { create: jest.fn() },
    };
    const svc = new ProjectReviewService({
      investment_projects: { findUnique: jest.fn().mockResolvedValue(proj) },
      user_investments: { findMany: jest.fn().mockResolvedValue(invs) },
      project_reviews: { create: jest.fn() },
      $transaction: jest.fn((fn: any) => fn(tx)),
    } as any);
    return { svc, tx };
  }
  const inv100 = [{ id: 'i1', user_id: 'u', amount: 100, status: 'committed' }];
  it('cancellation refunds unreleased funds plus the pro-rata reserve (15% is refundable)', async () => {
    const { svc, tx } = refundCtx(
      {
        raised_amount: 800,
        released_amount: 0,
        consolidation_fee: 120,
        consolidation_refunded: 0,
      },
      inv100,
    );
    const r = await (svc as any).refundAll('a', PID);
    expect(r.share).toBeCloseTo(1);
    expect(r.amount).toBe(100); // 85 held + 15 reserve; the 3% fee is not part of this
    expect(r.from_reserve).toBe(15);
    const debit = tx.ledger_entries.create.mock.calls
      .map((c: any) => c[0].data)
      .find((d: any) => d.wallet_id === 'platform');
    expect(debit).toMatchObject({
      entry_type: 'debit',
      amount: 15,
      category: 'consolidation_fund',
    });
  });
  it('cancellation after a release: share of unreleased funds + share of reserve', async () => {
    const { svc } = refundCtx(
      {
        raised_amount: 800,
        released_amount: 272,
        consolidation_fee: 120,
        consolidation_refunded: 0,
      },
      inv100,
    );
    const r = await (svc as any).refundAll('a', PID);
    expect(r.amount).toBe(66); // 51 (408/800) + 15 (120/800)
  });
  it("loss: pays this project's reserve pro-rata, once, with notes", async () => {
    const proj = {
      raised_amount: 800,
      consolidation_fee: 120,
      consolidation_refunded: 0,
      consolidation_released: 0,
      consolidation_fee_at: new Date(),
      status: 'closed',
    };
    const two = [
      { id: 'i1', user_id: 'u1', amount: 600, status: 'active' },
      { id: 'i2', user_id: 'u2', amount: 200, status: 'active' },
    ];
    await expect(
      refundCtx(proj, two).svc.refundReserveForLoss('a', PID, ' '),
    ).rejects.toThrow('Notes');
    const { svc, tx } = refundCtx(proj, two);
    const r = await svc.refundReserveForLoss('a', PID, 'harvest failed');
    expect(r.data.amount).toBe(120);
    expect(
      tx.wallets.update.mock.calls.map((c: any) => c[0].data.balance),
    ).toEqual([
      { increment: 90 },
      { decrement: 90 },
      { increment: 30 },
      { decrement: 30 },
    ]);
    await expect(
      refundCtx(
        { ...proj, consolidation_refunded: 120 },
        two,
      ).svc.refundReserveForLoss('a', PID, 'x'),
    ).rejects.toThrow('already refunded');
  });
  it('success: remaining reserve is reclassified to FARM revenue (no balance change)', async () => {
    const proj = {
      status: 'closed',
      project_name: 'P',
      raised_amount: 800,
      released_amount: 680,
      consolidation_fee: 120,
      consolidation_refunded: 0,
      consolidation_released: 0,
      consolidation_fee_at: new Date(),
    };
    await expect(
      refundCtx({ ...proj, released_amount: 272 }, []).svc.releaseReserveToFarm(
        'a',
        PID,
        'done',
      ),
    ).rejects.toThrow('All milestones');
    const { svc, tx } = refundCtx(proj, []);
    const r = await svc.releaseReserveToFarm('a', PID, 'completed');
    expect(r.data.amount).toBe(120);
    expect(tx.wallets.update).not.toHaveBeenCalled();
    expect(
      tx.ledger_entries.create.mock.calls.map((c: any) => [
        c[0].data.entry_type,
        c[0].data.category,
      ]),
    ).toEqual([
      ['debit', 'consolidation_fund'],
      ['credit', 'fee_revenue'],
    ]);
    await expect(
      refundCtx(
        { ...proj, consolidation_released: 120 },
        [],
      ).svc.refundReserveForLoss('a', PID, 'x'),
    ).rejects.toThrow('released to FARM');
  });
  it('investors see the live fee terms before investing', async () => {
    const svc = new MarketplaceService({} as any, {} as any, undefined as any);
    const f = await (svc as any).investorFees();
    expect(f.consolidation_percent).toBe(15);
    expect(f.investment_percent).toBe(3);
    expect(f.points.join(' ')).toContain('not refunded');
    expect(f.points.join(' ')).toContain('makes a loss');
    expect(f.points.join(' ')).toContain('kept by FARM');
  });
});
