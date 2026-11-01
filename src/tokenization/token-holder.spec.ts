import { TokenTransferService } from './token-transfer.service';
import {
  TokenDistributionService,
  splitProRata,
} from './token-distribution.service';

jest.mock('./on-invest', () => ({
  ...jest.requireActual('./on-invest'),
  onInvestConfig: () => ({ enabled: true }),
}));
jest.mock('../chain-wallet/key-vault', () => ({
  walletSigner: () => ({ wipe: jest.fn() }),
}));

const env = process.env;
afterEach(() => (process.env = env));

function transferMocks(o: any = {}) {
  const order: string[] = [];
  const alloc = {
    id: 'a1',
    user_id: 'u1',
    project_token_id: 'tok',
    units: 100n,
    sold_units: o.sold ?? 0n,
    status: o.status ?? 'owed',
    custody: 'farm_custody',
    address: o.status === 'delivered' ? 'FROM' : null,
    token: { asset_id: 5n, network: 'testnet', project: { status: 'funded' } },
  };
  const db: any = {
    token_allocations: {
      findUnique: jest.fn().mockResolvedValue(alloc),
      updateMany: jest.fn().mockResolvedValue({ count: o.claim ?? 1 }),
      create: jest.fn().mockResolvedValue({ id: 'a2' }),
      update: jest.fn(),
    },
    users: {
      findFirst: jest
        .fn()
        .mockResolvedValue(o.to === null ? null : { id: o.to ?? 'u2' }),
    },
    token_buybacks: { count: jest.fn().mockResolvedValue(o.openBuyback ?? 0) },
    token_transfers: {
      create: jest.fn(async ({ data }: any) => ({ id: 't1', ...data })),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({
        id: 't1',
        tx_id: 'storedTx' in o ? o.storedTx : 'TX',
        to_allocation_id: 'a2',
        from_allocation_id: 'a1',
        units: 10n,
      }),
    },
    user_chain_wallets: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          o.noWallet
            ? null
            : { address: 'TO', status: 'ready', network: 'testnet' },
        ),
    },
  };
  db.$transaction = (fn: any) => fn(db);
  const auth: any = { verifyPin: jest.fn() };
  const chain: any = {
    isOptedIn: jest.fn().mockResolvedValue(o.optedIn ?? true),
    optIn: jest.fn(() => order.push('optin')),
    prepareClawback: jest.fn().mockResolvedValue({
      txId: 'TX',
      lastValid: 9n,
      send: jest.fn(() => order.push('send')),
    }),
  };
  const asa: any = {
    issuerSigner: () => ({ address: 'ISS', wipe: jest.fn() }),
  };
  const topup: any = { ensure: jest.fn().mockResolvedValue(o.topup ?? 'sent') };
  return {
    svc: new TokenTransferService(db, auth, chain, asa, topup),
    db,
    auth,
    chain,
    topup,
    order,
  };
}
const dto = (units = 10) => ({
  recipient_identifier: 'bob',
  units,
  pin: '1234',
});

describe('TokenTransferService', () => {
  beforeEach(() => (process.env = { ...env, TOKEN_TRANSFERS_ENABLED: 'true' }));

  it('flag off -> refused', async () => {
    process.env.TOKEN_TRANSFERS_ENABLED = 'false';
    const { svc, db } = transferMocks();
    await expect(svc.send('u1', 'a1', dto())).rejects.toThrow(
      /not switched on/,
    );
    expect(db.token_transfers.create).not.toHaveBeenCalled();
  });

  it('checks the PIN and refuses more than held / self / unknown', async () => {
    const m = transferMocks({ sold: 95n });
    await expect(m.svc.send('u1', 'a1', dto(10))).rejects.toThrow(/hold 5/);
    expect(m.auth.verifyPin).toHaveBeenCalledWith('u1', '1234');
    await expect(
      transferMocks({ to: 'u1' }).svc.send('u1', 'a1', dto()),
    ).rejects.toThrow(/yourself/);
    await expect(
      transferMocks({ to: null }).svc.send('u1', 'a1', dto()),
    ).rejects.toThrow(/not found/);
  });

  it('refuses while a sell-back is open', async () => {
    await expect(
      transferMocks({ openBuyback: 1 }).svc.send('u1', 'a1', dto()),
    ).rejects.toThrow(/sell-back/);
  });

  it('owed tokens: DB move, new holding without investment (no sell-back)', async () => {
    const { svc, db, chain } = transferMocks();
    const r = await svc.send('u1', 'a1', dto(10));
    expect(r.data.status).toBe('completed');
    expect(chain.prepareClawback).not.toHaveBeenCalled();
    expect(db.token_allocations.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'a1', status: 'owed', units: 100n },
      data: { units: 90n },
    });
    expect(db.token_allocations.create.mock.calls[0][0].data).toMatchObject({
      user_id: 'u2',
      units: 10n,
      investment_id: null,
      source: 'transfer',
      status: 'owed',
    });
  });

  it('delivered tokens: recipient opted in via capped top-up, txId stored before send', async () => {
    const { svc, db, chain, topup, order } = transferMocks({
      status: 'delivered',
      optedIn: false,
    });
    const r = await svc.send('u1', 'a1', dto(10));
    expect(topup.ensure).toHaveBeenCalledWith('TO', 'token_optin', 101000n);
    expect(chain.prepareClawback.mock.calls[0][0]).toMatchObject({
      from: 'FROM',
      to: 'TO',
      amount: 10n,
    });
    expect(db.token_transfers.update.mock.calls[0][0].data).toMatchObject({
      tx_id: 'TX',
    });
    expect(order).toEqual(['optin', 'send']);
    expect(r.data.status).toBe('completed');
  });

  it('recipient cannot get ALGO -> refused before anything moves', async () => {
    const { svc, db } = transferMocks({
      status: 'delivered',
      optedIn: false,
      topup: 'capped',
    });
    await expect(svc.send('u1', 'a1', dto())).rejects.toThrow(/can't receive/);
    expect(db.token_allocations.updateMany).not.toHaveBeenCalled();
  });

  it('send fails before txId stored -> units restored to the sender', async () => {
    const m = transferMocks({ status: 'delivered', storedTx: null });
    m.chain.prepareClawback.mockRejectedValue(new Error('node down'));
    const r = await m.svc.send('u1', 'a1', dto(10));
    expect(r.data.status).toBe('reverted');
    expect(m.db.token_allocations.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'a1' },
      data: { units: { increment: 10n } },
    });
  });

  it('holding changed concurrently -> no transfer row', async () => {
    const { svc, db } = transferMocks({ claim: 0 });
    await expect(svc.send('u1', 'a1', dto())).rejects.toThrow(/changed/);
    expect(db.token_transfers.create).not.toHaveBeenCalled();
  });
});

describe('splitProRata', () => {
  it('splits by units, rounds down, never over the amount', () => {
    const { total, rows } = splitProRata(100, [
      { user_id: 'a', units: 1n },
      { user_id: 'b', units: 2n },
    ]);
    expect(total).toBe(3n);
    expect(rows.map((r) => r.amount)).toEqual([33.33, 66.66]);
  });
});

function distMocks(o: any = {}) {
  const db: any = {
    investment_projects: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'p1',
        status: 'funded',
        business_id: 'biz',
        token: { id: 'tok', status: 'created', asset_id: 5n },
        business: { owner_user_id: 'owner' },
      }),
    },
    token_distributions: {
      create: jest.fn(async ({ data }: any) => ({ id: 'd1', ...data })),
      findUnique: jest.fn().mockResolvedValue({
        id: 'd1',
        project_id: 'p1',
        amount: 100,
        fee: o.fee ?? 0,
        source: o.source,
        kind: 'rental',
        status: 'requested',
      }),
      updateMany: jest.fn().mockResolvedValue({ count: o.claim ?? 1 }),
      update: jest.fn(),
    },
    token_allocations: {
      count: jest.fn().mockResolvedValue(o.inFlight ?? 0),
      findMany: jest.fn().mockResolvedValue([
        { user_id: 'owedUser', units: 40n, sold_units: 10n, status: 'owed' },
        {
          user_id: 'chainUser',
          units: 999n,
          sold_units: 0n,
          status: 'delivered',
        },
      ]),
    },
    user_chain_wallets: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ user_id: 'chainUser', address: 'CH' }]),
    },
    wallets: {
      findFirst: jest.fn(async ({ where }: any) => ({
        id: `w-${where.user_id}`,
      })),
      updateMany: jest
        .fn()
        .mockResolvedValue({ count: o.funds === false ? 0 : 1 }),
      update: jest.fn(),
    },
    transactions: { create: jest.fn().mockResolvedValue({ id: 'tx' }) },
    ledger_entries: { create: jest.fn() },
    token_distribution_payouts: { create: jest.fn() },
    users: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'admin', wallets: [{ id: 'pw' }] }),
    },
    $executeRaw: jest.fn().mockResolvedValue(o.returnsClaim ?? 1),
  };
  db.wallets.findUnique = jest.fn().mockResolvedValue({ id: 'pw', balance: 0 });
  db.$transaction = (fn: any) => fn(db);
  const access: any = {
    resolve: jest.fn().mockResolvedValue({ business: { id: 'biz' } }),
  };
  const chain: any = { assetBalance: jest.fn().mockResolvedValue(70n) };
  return { svc: new TokenDistributionService(db, access, chain), db, chain };
}

describe('TokenDistributionService', () => {
  beforeEach(
    () => (process.env = { ...env, TOKEN_DISTRIBUTIONS_ENABLED: 'true' }),
  );

  it('flag off -> refused', async () => {
    process.env.TOKEN_DISTRIBUTIONS_ENABLED = 'false';
    const { svc, db } = distMocks();
    await expect(
      svc.businessRequest('b', 'p1', { amount: 10 }),
    ).rejects.toThrow(/not switched on/);
    expect(db.token_distributions.create).not.toHaveBeenCalled();
  });

  it('business request waits for admin approval, 2% FARM fee', async () => {
    const { svc, db } = distMocks();
    const r = await svc.businessRequest('b', 'p1', {
      amount: 50,
      kind: 'rental',
    });
    expect(r.message).toMatch(/approval/);
    expect(db.token_distributions.create.mock.calls[0][0].data).toMatchObject({
      amount: 50,
      fee: 1,
      kind: 'rental',
    });
    expect(db.wallets.updateMany).not.toHaveBeenCalled();
  });

  it('snapshot: on-chain balance for delivered, DB units minus sold for owed', async () => {
    const { svc, chain } = distMocks();
    const h = await svc.snapshot('tok', 5n);
    expect(h).toEqual([
      { user_id: 'owedUser', units: 30n },
      { user_id: 'chainUser', units: 70n },
    ]);
    expect(chain.assetBalance).toHaveBeenCalledWith('CH', 5n);
  });

  it('snapshot refused while tokens are moving', async () => {
    await expect(
      distMocks({ inFlight: 1 }).svc.snapshot('tok', 5n),
    ).rejects.toThrow(/moving/);
  });

  it('approve pays pro-rata from the business wallet with per-holder payouts', async () => {
    const { svc, db } = distMocks();
    const r = await svc.approve('admin', 'd1');
    expect(r.data).toMatchObject({ status: 'paid', paid: 100, holders: 2 });
    expect(db.wallets.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'w-owner', balance: { gte: 100 } },
      data: { balance: { decrement: 100 } },
    });
    const pays = db.token_distribution_payouts.create.mock.calls.map(
      (c: any) => c[0].data,
    );
    expect(pays).toEqual([
      expect.objectContaining({ user_id: 'owedUser', amount: 30, units: 30n }),
      expect.objectContaining({ user_id: 'chainUser', amount: 70, units: 70n }),
    ]);
  });

  it('idempotent: a second approval that loses the claim pays nothing', async () => {
    const { svc, db } = distMocks({ claim: 0 });
    await expect(svc.approve('admin', 'd1')).rejects.toThrow(/already handled/);
    expect(db.wallets.update).not.toHaveBeenCalled();
    expect(db.token_distribution_payouts.create).not.toHaveBeenCalled();
  });

  it('business wallet short -> nothing paid, marked failed', async () => {
    const { svc, db } = distMocks({ funds: false });
    await expect(svc.approve('admin', 'd1')).rejects.toThrow(/needs 100 FARM/);
    expect(db.wallets.update).not.toHaveBeenCalled();
    expect(
      db.token_distributions.updateMany.mock.calls.at(-1)[0].data.status,
    ).toBe('failed');
  });

  it('2% fee: holders split 98, the fee is FARM revenue', async () => {
    const { svc, db } = distMocks({ fee: 2 });
    const r = await svc.approve('admin', 'd1');
    expect(r.data).toMatchObject({ paid: 98, fee: 2, holders: 2 });
    expect(db.wallets.updateMany.mock.calls[0][0].data.balance.decrement).toBe(
      100,
    );
    const pays = db.token_distribution_payouts.create.mock.calls.map(
      (c: any) => c[0].data.amount,
    );
    expect(pays.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(98);
    const fee = db.ledger_entries.create.mock.calls
      .map((c: any) => c[0].data)
      .find((d: any) => d.category === 'token_distribution_fee');
    expect(fee).toMatchObject({
      wallet_id: 'pw',
      amount: 2,
      entry_type: 'credit',
    });
  });

  it('fee percent is configurable and clamped', () => {
    const { distributionFee, distributionFeePercent } = jest.requireActual(
      './token-distribution.service',
    );
    expect(distributionFee(50)).toBe(1);
    expect(distributionFee(50, { TOKEN_DISTRIBUTION_FEE_PERCENT: '5' })).toBe(
      2.5,
    );
    expect(
      distributionFeePercent({ TOKEN_DISTRIBUTION_FEE_PERCENT: 'x' }),
    ).toBe(2);
  });

  it('project_returns source pays from the platform wallet behind a guarded claim', async () => {
    const { svc, db } = distMocks({ source: 'project_returns', fee: 2 });
    await svc.approve('system', 'd1');
    expect(db.$executeRaw).toHaveBeenCalled();
    expect(db.wallets.updateMany).not.toHaveBeenCalled();
    expect(db.wallets.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'pw' },
      data: { balance: { decrement: 100 } },
    });
    const short = distMocks({ source: 'project_returns', returnsClaim: 0 });
    await expect(short.svc.approve('system', 'd1')).rejects.toThrow(
      /Not enough project returns/,
    );
    expect(short.db.token_distribution_payouts.create).not.toHaveBeenCalled();
  });
});
