import { ProjectFundsService, monthKey } from './project-funds.service';
import {
  ProjectFundsChainService,
  toUnits,
} from './project-funds-chain.service';
import { autoPayoutsEnabled, fundsCaps } from './funds-flow-rules';

const PID = '11111111-1111-1111-1111-111111111111';
const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
});
const on = (auto = false) => {
  process.env.PROJECT_FUNDS_FLOW_ENABLED = 'true';
  if (auto) process.env.PROJECT_AUTO_PAYOUTS_ENABLED = 'true';
};

function mocks(o: any = {}) {
  const project = {
    id: PID,
    project_name: 'Greenhouse',
    business_id: 'biz',
    status: 'funded',
    raised_amount: 1000,
    consolidation_fee: 150,
    consolidation_fee_at: new Date(),
    released_amount: 0,
    returns_deposited: 0,
    returns_distributed: 0,
    distribution_mode: 'off',
    distribution_percent: 0,
    funds_paused: false,
    business: { owner_user_id: 'owner' },
    milestones: [],
    ...o.project,
  };
  const tx: any = {
    $executeRaw: jest.fn().mockResolvedValue(o.claim ?? 1),
    project_funds_audit: {
      aggregate: jest
        .fn()
        .mockResolvedValue({ _sum: { amount: o.today ?? 0 } }),
      create: jest.fn(),
    },
    business_invoices: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    business_payment_links: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    wallets: {
      findFirst: jest.fn(async ({ where }: any) => ({
        id: `w-${where.user_id}`,
      })),
      update: jest.fn(),
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: o.funds === false ? 0 : 1 }),
      findUnique: jest.fn().mockResolvedValue({ id: 'pw', balance: 0 }),
    },
    users: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'admin', wallets: [{ id: 'pw' }] }),
    },
    transactions: {
      create: jest.fn().mockResolvedValue({ id: 'tx1' }),
      findUnique: jest.fn().mockResolvedValue(o.srcTx ?? null),
    },
    ledger_entries: { create: jest.fn() },
    business_payments: { create: jest.fn() },
    project_spends: {
      create: jest.fn(async ({ data }: any) => {
        if (o.dupe) throw Object.assign(new Error('dupe'), { code: 'P2002' });
        return { id: 's1', ...data };
      }),
    },
    project_returns: {
      create: jest.fn(async ({ data }: any) => ({ id: 'r1', ...data })),
    },
    investment_projects: { update: jest.fn() },
  };
  const prisma: any = {
    investment_projects: {
      findFirst: jest.fn().mockResolvedValue(project),
      findUnique: jest.fn().mockResolvedValue(project),
      findMany: jest.fn().mockResolvedValue([project]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    business_invoices: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'inv1',
        business_id: o.recipientBiz ?? 'supplier',
        total: 400,
        status: 'sent',
        invoice_number: 'INV-1',
      }),
    },
    business_payment_links: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'l1',
        business_id: 'supplier',
        amount: 50,
        title: 'Seeds',
        is_active: true,
        use_count: 2,
        max_uses: null,
        expires_at: null,
      }),
    },
    businesses: {
      findUnique: jest.fn().mockResolvedValue({
        owner_user_id: o.recipientOwner ?? 'supplierOwner',
        status: o.recipientStatus ?? 'approved',
        trading_name: 'AgriSupply',
      }),
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'supplier', trading_name: 'AgriSupply' }]),
    },
    project_spends: {
      findUnique: jest.fn().mockResolvedValue(o.prior ?? null),
      findMany: jest.fn().mockResolvedValue(o.spends ?? []),
    },
    project_returns: { findMany: jest.fn().mockResolvedValue(o.returns ?? []) },
    project_escrows: { findUnique: jest.fn().mockResolvedValue(null) },
    token_distributions: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount: o.open ?? 0 } }),
      findMany: jest.fn().mockResolvedValue(o.dists ?? []),
      findUnique: jest.fn().mockResolvedValue(o.dist ?? null),
    },
    project_funds_audit: { create: jest.fn() },
    user_investments: { count: jest.fn().mockResolvedValue(o.inv ?? 0) },
    token_allocations: { count: jest.fn().mockResolvedValue(o.held ?? 0) },
    $transaction: jest.fn((fn: any) => fn(tx)),
  };
  const access: any = {
    resolve: jest.fn().mockResolvedValue({ business: { id: 'biz' } }),
  };
  const auth: any = { verifyPin: jest.fn() };
  const dist: any = {
    propose: jest.fn(
      async (_p: string, amount: number, kind: string, key: string) =>
        o.proposeDupe ? null : { id: 'd1', amount, kind, period_key: key },
    ),
    approve: jest.fn().mockResolvedValue({
      data: {
        paid: 98,
        fee: 2,
        holders: 2,
        payouts: [
          { user_id: 'h1', amount: 49 },
          { user_id: 'h2', amount: 49 },
        ],
      },
    }),
  };
  const chain: any = {
    enabled: jest.fn().mockReturnValue(false),
    enqueue: jest.fn(),
    audit: jest.fn(),
    alertAdmins: jest.fn(),
    provision: jest.fn(),
  };
  const svc = new ProjectFundsService(prisma, access, auth, dist, chain);
  return { svc, prisma, tx, dist, chain, auth };
}

const spend = {
  kind: 'invoice',
  ref: 'INV-1',
  pin: '1234',
  tag: 'Greenhouse kit',
};

describe('Project funds flow – flags and rails', () => {
  it('everything is off by default', async () => {
    delete process.env.PROJECT_FUNDS_FLOW_ENABLED;
    const { svc, tx } = mocks();
    await expect(svc.spend('u', PID, spend)).rejects.toThrow(/not switched on/);
    expect(tx.wallets.update).not.toHaveBeenCalled();
    expect(autoPayoutsEnabled({})).toBe(false);
  });
  it('auto payouts need both flags, no kill switch, and TestNet', () => {
    const e = {
      PROJECT_FUNDS_FLOW_ENABLED: 'true',
      PROJECT_AUTO_PAYOUTS_ENABLED: 'true',
    };
    expect(autoPayoutsEnabled(e)).toBe(true);
    expect(
      autoPayoutsEnabled({ ...e, PROJECT_PAYOUTS_KILL_SWITCH: 'true' }),
    ).toBe(false);
    expect(
      autoPayoutsEnabled({
        ...e,
        ALGORAND_NETWORK: 'mainnet',
        ALGORAND_ALLOW_MAINNET: 'true',
      }),
    ).toBe(false);
  });
  it('default caps', () => {
    expect(fundsCaps({})).toMatchObject({
      perPayment: 10000,
      perProjectDaily: 25000,
      globalDaily: 100000,
    });
    expect(toUnits(12.34)).toBe(1234n);
  });
  it('kill switch stops spends', async () => {
    on();
    process.env.PROJECT_PAYOUTS_KILL_SWITCH = 'true';
    await expect(mocks().svc.spend('u', PID, spend)).rejects.toThrow(
      /paused platform-wide/,
    );
  });
  it('admin pause stops spends', async () => {
    on();
    await expect(
      mocks({ project: { funds_paused: true } }).svc.spend('u', PID, spend),
    ).rejects.toThrow(/paused by FARM/);
  });
});

describe('Project funds flow – pay from project funds', () => {
  it('pays an invoice of another business, guarded, audited, alerted, with a tag', async () => {
    on();
    const { svc, tx, chain, auth } = mocks();
    const r = await svc.spend('owner', PID, spend);
    expect(auth.verifyPin).toHaveBeenCalledWith('owner', '1234');
    expect(r.data).toMatchObject({
      amount: 400,
      recipient: 'AgriSupply',
      status: 'successful',
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2); // advisory lock + guarded claim
    expect(tx.wallets.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'w-supplierOwner' },
      data: { balance: { increment: 400 } },
    });
    expect(tx.business_invoices.updateMany.mock.calls[0][0].data.status).toBe(
      'paid',
    );
    expect(tx.project_spends.create.mock.calls[0][0].data).toMatchObject({
      tag: 'Greenhouse kit',
      idempotency_key: 'invoice:inv1',
    });
    expect(tx.project_funds_audit.create.mock.calls[0][0].data).toMatchObject({
      action: 'spend',
      amount: 400,
    });
    expect(chain.enqueue.mock.calls[0][0]).toMatchObject({
      kind: 'spend',
      from: 'escrow',
      to: { userId: 'supplierOwner' },
    });
    expect(chain.alertAdmins).toHaveBeenCalled();
  });
  it('pays a payment link (use reserved by compare-and-set)', async () => {
    on();
    const { svc, tx } = mocks();
    await svc.spend('owner', PID, {
      kind: 'payment_link',
      ref: 'abc',
      pin: '1234',
    });
    expect(
      tx.business_payment_links.updateMany.mock.calls[0][0].where,
    ).toMatchObject({ use_count: 2 });
    expect(tx.project_spends.create.mock.calls[0][0].data.idempotency_key).toBe(
      'link:l1:2',
    );
  });
  it('never pays the project owner or its own business', async () => {
    on();
    await expect(
      mocks({ recipientBiz: 'biz' }).svc.spend('owner', PID, spend),
    ).rejects.toThrow(/own business/);
    await expect(
      mocks({ recipientOwner: 'owner' }).svc.spend('owner', PID, spend),
    ).rejects.toThrow(/project owner/);
    await expect(
      mocks({ recipientStatus: 'pending' }).svc.spend('owner', PID, spend),
    ).rejects.toThrow(/approved FARM business/);
  });
  it('refuses more than the locked balance (guarded claim)', async () => {
    on();
    const { svc, tx } = mocks({ claim: 0 });
    await expect(svc.spend('owner', PID, spend)).rejects.toThrow(
      /Not enough project funds/,
    );
    expect(tx.wallets.update).not.toHaveBeenCalled();
  });
  it('per-payment, per-project daily and global daily caps', async () => {
    on();
    process.env.PROJECT_SPEND_MAX_PER_PAYMENT = '100';
    await expect(mocks().svc.spend('owner', PID, spend)).rejects.toThrow(
      /capped at 100/,
    );
    delete process.env.PROJECT_SPEND_MAX_PER_PAYMENT;
    await expect(
      mocks({ today: 24800 }).svc.spend('owner', PID, spend),
    ).rejects.toThrow(/Daily limit/);
    process.env.PROJECT_PAYOUT_DAILY_CAP = '1000000';
    await expect(
      mocks({ today: 99800 }).svc.spend('owner', PID, spend),
    ).rejects.toThrow(/Platform daily limit/);
  });
  it('idempotent: same key returns the earlier payment, no second move', async () => {
    on();
    const { svc, tx } = mocks({
      prior: { id: 's0', amount: 400, transaction_reference: 'R' },
    });
    const r = await svc.spend('owner', PID, {
      ...spend,
      idempotency_key: 'abcdefgh',
    });
    expect(r.message).toBe('Already paid');
    expect(tx.wallets.update).not.toHaveBeenCalled();
    await expect(
      mocks({ dupe: true }).svc.spend('owner', PID, spend),
    ).rejects.toThrow(/already made/);
  });
  it('only after the round has closed', async () => {
    on();
    await expect(
      mocks({ project: { status: 'listed' } }).svc.spend('owner', PID, spend),
    ).rejects.toThrow(/round has closed/);
  });
});

describe('Project funds flow – returns and automatic payouts', () => {
  it('deposit debits the business wallet with a guard and goes to escrow', async () => {
    on();
    const { svc, tx, chain } = mocks();
    await svc.deposit('owner', PID, { amount: 100, pin: '1234' });
    expect(tx.wallets.updateMany.mock.calls[0][0]).toMatchObject({
      where: { balance: { gte: 100 } },
    });
    expect(
      tx.investment_projects.update.mock.calls[0][0].data.returns_deposited
        .increment,
    ).toBe(100);
    expect(chain.enqueue.mock.calls[0][0]).toMatchObject({
      kind: 'return_in',
      to: 'escrow',
    });
    await expect(
      mocks({ funds: false }).svc.deposit('owner', PID, {
        amount: 100,
        pin: '1',
      }),
    ).rejects.toThrow(/needs 100/);
  });
  it('tagging a payment twice is refused', async () => {
    on();
    const { svc, tx } = mocks({
      srcTx: {
        status: 'completed',
        receiver_wallet_id: 'w-owner',
        amount: 100,
      },
    });
    tx.project_returns.create.mockRejectedValueOnce(
      Object.assign(new Error('x'), { code: 'P2002' }),
    );
    await expect(
      svc.deposit('owner', PID, {
        amount: 50,
        transaction_id: '22222222-2222-2222-2222-222222222222',
        pin: '1',
      }),
    ).rejects.toThrow(/already tagged/);
  });
  it('on_deposit: proposes X% and, with auto payouts on, pays it with the fee', async () => {
    on(true);
    const m = mocks({
      project: {
        distribution_mode: 'on_deposit',
        distribution_percent: 50,
        returns_deposited: 100,
      },
      dist: {
        id: 'd1',
        source: 'project_returns',
        status: 'requested',
        amount: 50,
        project_id: PID,
      },
    });
    const r = await m.svc.deposit('owner', PID, { amount: 100, pin: '1' });
    expect(m.dist.propose.mock.calls[0].slice(1, 4)).toEqual([
      50,
      'profit',
      'r:r1',
    ]);
    expect(r.data.proposal_id).toBe('d1');
    expect(m.dist.approve).toHaveBeenCalledWith('system', 'd1');
    const kinds = m.chain.enqueue.mock.calls.map((c: any) => c[0].kind);
    expect(kinds).toEqual(['return_in', 'holder', 'holder', 'fee']);
  });
  it('auto payouts off: the proposal waits for an admin', async () => {
    on(false);
    const m = mocks({
      project: {
        distribution_mode: 'on_deposit',
        distribution_percent: 50,
        returns_deposited: 100,
      },
    });
    await m.svc.deposit('owner', PID, { amount: 100, pin: '1' });
    expect(m.dist.approve).not.toHaveBeenCalled();
  });
  it('auto payout over the daily cap is held and admins are alerted', async () => {
    on(true);
    const m = mocks({
      today: 25000,
      dist: {
        id: 'd1',
        source: 'project_returns',
        status: 'requested',
        amount: 50,
        project_id: PID,
      },
    });
    expect(await m.svc.autoPay('d1')).toEqual({ auto: false, reason: 'cap' });
    expect(m.dist.approve).not.toHaveBeenCalled();
    expect(m.chain.alertAdmins).toHaveBeenCalled();
  });
  it('monthly: one proposal per month key (duplicates skipped)', async () => {
    on();
    const m = mocks({
      project: {
        distribution_mode: 'monthly',
        distribution_percent: 10,
        returns_deposited: 500,
      },
    });
    await m.svc.tick(new Date('2026-11-01T10:00:00Z'));
    expect(m.dist.propose.mock.calls[0][1]).toBe(50);
    expect(m.dist.propose.mock.calls[0][3]).toBe('m:2026-11');
    expect(monthKey(new Date('2026-01-31T23:00:00Z'))).toBe('m:2026-01');
    const dupe = mocks({
      proposeDupe: true,
      project: {
        distribution_mode: 'monthly',
        distribution_percent: 10,
        returns_deposited: 500,
      },
    });
    process.env.PROJECT_AUTO_PAYOUTS_ENABLED = 'true';
    await dupe.svc.tick();
    expect(dupe.dist.approve).not.toHaveBeenCalled();
  });
  it('open proposals reduce what is available', async () => {
    on();
    expect(
      await mocks({
        project: { returns_deposited: 100, returns_distributed: 20 },
        open: 30,
      }).svc.available(PID),
    ).toBe(50);
  });
});

describe('Project funds flow – timeline', () => {
  it('investors see every spend, return and payout; outsiders are refused', async () => {
    on();
    await expect(mocks().svc.investorTimeline('x', PID)).rejects.toThrow(
      /investors/,
    );
    const m = mocks({
      inv: 1,
      project: {
        released_amount: 400,
        returns_deposited: 100,
        returns_distributed: 50,
      },
      spends: [
        {
          created_at: new Date(),
          amount: 400,
          recipient_business_id: 'supplier',
          target_kind: 'invoice',
          tag: 'Kit',
          transaction_reference: 'R',
        },
      ],
      returns: [
        {
          created_at: new Date(),
          amount: 100,
          source: 'manual',
          note: 'Harvest',
        },
      ],
      dists: [
        {
          status: 'paid',
          updated_at: new Date(),
          paid_amount: 49,
          fee: 1,
          kind: 'rental',
          holders: 3,
        },
      ],
    });
    const t = (await m.svc.investorTimeline('inv', PID)).data;
    expect(t.summary).toMatchObject({
      raised: 1000,
      buyback_hold: 150,
      locked: 450,
      spent: 400,
      returns: 100,
      distributed: 50,
      returns_available: 50,
    });
    expect(t.events.map((e: any) => e.type)).toEqual([
      'funded',
      'spent',
      'return',
      'distributed',
    ]);
    expect(t.events[1]).toMatchObject({
      label: 'Paid AgriSupply (invoice)',
      tag: 'Kit',
    });
  });
});

describe('Project funds chain outbox', () => {
  function chainMocks(o: any = {}) {
    const db: any = {
      project_escrows: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'e',
          project_id: PID,
          address: 'ESCROW',
          status: 'ready',
        }),
      },
      user_chain_wallets: {
        findUnique: jest.fn().mockResolvedValue(o.wallet ?? null),
      },
      project_chain_moves: {
        create: jest.fn(async ({ data }: any) => {
          if (o.dupe) throw Object.assign(new Error('d'), { code: 'P2002' });
          return { id: 'mv', ...data };
        }),
      },
    };
    const client: any = {};
    return { svc: new ProjectFundsChainService(db, client), db };
  }
  it('no-op unless auto payouts are on', async () => {
    const { svc, db } = chainMocks();
    expect(
      await svc.enqueue({
        projectId: PID,
        kind: 'spend',
        from: 'escrow',
        to: 'reserve',
        amount: 1,
        key: 'k',
      }),
    ).toBeNull();
    expect(db.project_chain_moves.create).not.toHaveBeenCalled();
  });
  it('escrow -> user custodial address, or the reserve when they have none; idempotent by key', async () => {
    on(true);
    process.env.FARM_RESERVE_ADDRESS = 'RESERVE';
    const a = chainMocks({ wallet: { status: 'ready', address: 'USER' } });
    jest.spyOn(a.svc, 'enabled').mockReturnValue(true);
    await a.svc.enqueue({
      projectId: PID,
      kind: 'holder',
      from: 'escrow',
      to: { userId: 'u' },
      amount: 1.5,
      key: 'k',
    });
    expect(a.db.project_chain_moves.create.mock.calls[0][0].data).toMatchObject(
      { from_address: 'ESCROW', to_address: 'USER', units: 150n },
    );
    const b = chainMocks();
    jest.spyOn(b.svc, 'enabled').mockReturnValue(true);
    await b.svc.enqueue({
      projectId: PID,
      kind: 'holder',
      from: 'escrow',
      to: { userId: 'u' },
      amount: 1,
      key: 'k',
    });
    expect(
      b.db.project_chain_moves.create.mock.calls[0][0].data.to_address,
    ).toBe('RESERVE');
    const c = chainMocks({ dupe: true });
    jest.spyOn(c.svc, 'enabled').mockReturnValue(true);
    expect(
      await c.svc.enqueue({
        projectId: PID,
        kind: 'fee',
        from: 'escrow',
        to: 'reserve',
        amount: 1,
        key: 'k',
      }),
    ).toBeNull();
  });
});
