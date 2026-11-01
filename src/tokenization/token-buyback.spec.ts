import { BadRequestException } from '@nestjs/common';
import { TokenBuybackService } from './token-buyback.service';

jest.mock('../project-marketplace/consolidation', () => ({
  ...jest.requireActual('../project-marketplace/consolidation'),
  payBuybackFromReserveInTx: jest.fn(),
}));
jest.mock('./on-invest', () => ({
  onInvestConfig: () => ({ enabled: true }),
}));
import { payBuybackFromReserveInTx } from '../project-marketplace/consolidation';
const pay = payBuybackFromReserveInTx as jest.Mock;

const project = (o: any = {}) => ({
  status: 'funded',
  raised_amount: 1000,
  consolidation_fee: 150,
  consolidation_fee_at: new Date(),
  consolidation_refunded: 0,
  consolidation_released: 0,
  consolidation_bought_back: 0,
  ...o,
});

function make(o: any = {}) {
  const order: string[] = [];
  const buyback = {
    id: 'b1',
    allocation_id: 'a1',
    project_id: 'p1',
    user_id: 'u1',
    units: 10n,
    amount: 10,
    status: o.bStatus ?? 'requested',
    from_status: o.from ?? 'owed',
    tx_id: o.txId ?? null,
    last_valid: null,
  };
  const alloc = {
    id: 'a1',
    user_id: 'u1',
    investment_id: 'i1',
    units: 100n,
    sold_units: o.soldUnits ?? 0n,
    status: o.from ?? 'owed',
    address: 'ADDR',
    token: { project_id: 'p1', asset_id: 5n },
  };
  const invs = [{ amount: 100, sold_back_amount: o.soldBack ?? 0 }];
  const db: any = {
    investment_projects: {
      findUnique: jest.fn().mockResolvedValue(project(o.project)),
    },
    user_investments: {
      findMany: jest.fn().mockResolvedValue(invs),
      update: jest.fn(),
    },
    token_buybacks: {
      aggregate: jest
        .fn()
        .mockResolvedValueOnce({ _sum: { amount: o.pending ?? 0 } })
        .mockResolvedValue({ _sum: { amount: o.allPending ?? 0 } }),
      create: jest.fn().mockResolvedValue(buyback),
      findUnique: jest.fn().mockResolvedValue(buyback),
      updateMany: jest.fn().mockResolvedValue({ count: o.claim ?? 1 }),
      update: jest.fn(),
    },
    token_allocations: {
      findUnique: jest.fn().mockResolvedValue(alloc),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    wallets: {
      findFirst: jest.fn().mockResolvedValue({ id: 'w1' }),
      update: jest.fn(() => order.push('credit')),
    },
    transactions: { create: jest.fn().mockResolvedValue({ id: 't1' }) },
    ledger_entries: { create: jest.fn() },
  };
  db.$transaction = (fn: any) => fn(db);
  const chain: any = {
    txStatus: jest.fn().mockResolvedValue('confirmed'),
    currentRound: jest.fn().mockResolvedValue(1n),
    prepareClawback: jest.fn().mockResolvedValue({
      txId: 'TX',
      lastValid: 9n,
      send: jest.fn(() => order.push('clawback')),
    }),
  };
  const asa: any = {
    issuerSigner: () => ({ address: 'ISSUER', wipe: jest.fn() }),
  };
  return {
    svc: new TokenBuybackService(db, chain, asa),
    db,
    chain,
    order,
  };
}

describe('TokenBuybackService', () => {
  const env = process.env;
  beforeEach(() => {
    process.env = {
      ...env,
      TOKEN_BUYBACK_ENABLED: 'true',
      TOKENIZE_ON_INVEST_ENABLED: 'true',
    };
    pay.mockReset().mockResolvedValue(true);
  });
  afterAll(() => (process.env = env));

  it('flag off -> rejects requests and approvals', async () => {
    process.env.TOKEN_BUYBACK_ENABLED = 'false';
    const { svc, db } = make();
    await expect(svc.request('u1', 'a1', 5)).rejects.toThrow(/not switched on/);
    await expect(svc.approve('admin', 'b1')).rejects.toThrow(/not switched on/);
    expect(db.token_buybacks.create).not.toHaveBeenCalled();
  });

  it('allowance is 15% of what this investor invested, cumulative', async () => {
    const { svc } = make({ soldBack: 5, pending: 3 });
    const a = await svc.allowance('u1', 'p1');
    expect(a).toMatchObject({
      percent: 15,
      cap: 15,
      sold_back: 5,
      pending: 3,
      remaining: 7,
      available: 7,
      open: true,
    });
  });

  it('over the per-investor cap -> rejected, not queued', async () => {
    const { svc, db } = make({ soldBack: 10 });
    await expect(svc.request('u1', 'a1', 6)).rejects.toThrow(
      /15% of what you invested: 5 FARM/,
    );
    expect(db.token_buybacks.create).not.toHaveBeenCalled();
  });

  it('project pool safety -> rejected when the pool is short', async () => {
    const { svc, db } = make({
      project: { consolidation_released: 140 },
    });
    await expect(svc.request('u1', 'a1', 12)).rejects.toThrow(
      /buyback fund only has 10/,
    );
    expect(db.token_buybacks.create).not.toHaveBeenCalled();
  });

  it('not funded yet -> sell-back closed', async () => {
    const { svc } = make({
      project: {
        status: 'open',
        consolidation_fee_at: null,
        consolidation_fee: 0,
      },
    });
    await expect(svc.request('u1', 'a1', 1)).rejects.toThrow(
      /once the project is funded/,
    );
  });

  it('within the cap -> creates a request for admin approval', async () => {
    const { svc, db } = make();
    const r = await svc.request('u1', 'a1', 10);
    expect(r.message).toMatch(/approval/);
    expect(db.token_buybacks.create.mock.calls[0][0].data).toMatchObject({
      amount: 10,
      from_status: 'owed',
    });
  });

  it('owed tokens: approve settles in the DB only, no chain call', async () => {
    const { svc, db, chain } = make();
    const r = await svc.approve('admin', 'b1');
    expect(r.data.status).toBe('paid');
    expect(chain.prepareClawback).not.toHaveBeenCalled();
    expect(pay).toHaveBeenCalledWith(db, 'p1', 10, 't1');
    expect(db.user_investments.update.mock.calls[0][0].data).toEqual({
      sold_back_amount: { increment: 10 },
    });
    expect(db.wallets.update.mock.calls[0][0].data).toEqual({
      balance: { increment: 10 },
    });
  });

  it('delivered tokens: claw back to the issuer BEFORE crediting FARM', async () => {
    const { svc, db, chain, order } = make({ from: 'delivered' });
    await svc.approve('admin', 'b1');
    expect(chain.prepareClawback.mock.calls[0][0]).toMatchObject({
      from: 'ADDR',
      to: 'ISSUER',
      amount: 10n,
    });
    expect(db.token_buybacks.update.mock.calls[0][0].data).toMatchObject({
      tx_id: 'TX',
    });
    expect(order).toEqual(['clawback', 'credit']);
  });

  it('delivered + return already confirmed -> no second clawback', async () => {
    const { svc, chain } = make({
      from: 'delivered',
      bStatus: 'failed',
      txId: 'OLD',
    });
    await svc.approve('admin', 'b1');
    expect(chain.prepareClawback).not.toHaveBeenCalled();
  });

  it('settle is idempotent: second claim loses -> no payment', async () => {
    const { svc, db } = make({ claim: 0 });
    await expect(svc.settle('b1', 'approved')).rejects.toThrow(
      /already settled/,
    );
    expect(pay).not.toHaveBeenCalled();
    expect(db.wallets.update).not.toHaveBeenCalled();
  });

  it('settle re-checks the cumulative cap', async () => {
    const { svc, db } = make({ soldBack: 10 });
    await expect(svc.settle('b1', 'approved')).rejects.toThrow(
      BadRequestException,
    );
    expect(db.wallets.update).not.toHaveBeenCalled();
  });

  it('pool guard fails inside settle -> no credit, marked failed', async () => {
    pay.mockResolvedValue(false);
    const { svc, db } = make();
    await expect(svc.settle('b1', 'approved')).rejects.toThrow(
      /does not have enough/,
    );
    expect(db.wallets.update).not.toHaveBeenCalled();
    expect(db.token_buybacks.updateMany.mock.calls.at(-1)[0].data.status).toBe(
      'failed',
    );
  });

  it('reject needs notes and refuses rows with a token return in flight', async () => {
    const { svc, db } = make();
    await expect(svc.reject('admin', 'b1', ' ')).rejects.toThrow(/Notes/);
    await svc.reject('admin', 'b1', 'no');
    expect(db.token_buybacks.updateMany.mock.calls[0][0].where).toMatchObject({
      tx_id: null,
    });
  });
});
