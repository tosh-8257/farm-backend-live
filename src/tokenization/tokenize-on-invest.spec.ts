import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { TokenizationService } from './tokenization.service';
import { TokenDeliveryService } from './token-delivery.service';
import { allocateOnInvestInTx, onInvestConfig, unitsFor } from './on-invest';
import * as vault from '../chain-wallet/key-vault';

const PID = '11111111-1111-1111-1111-111111111111';
const ENV: Record<string, string> = {
  TOKENIZATION_ENABLED: 'true',
  TOKENIZE_ON_INVEST_ENABLED: 'true',
  ALGORAND_NETWORK: 'testnet',
  ALGORAND_NODE_URL: 'https://node.example',
  ALGORAND_INDEXER_URL: 'https://idx.example',
  ALGORAND_ISSUER_MNEMONIC: 'x',
  CHAIN_WALLETS_ENABLED: 'true',
  ALGORAND_FUNDER_MNEMONIC: 'x',
  WALLET_KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  USDC_ASA_ID: '10458941',
  FARM_ASA_ID: '42',
  FARM_RESERVE_ADDRESS: 'R'.repeat(58),
};
const ADDR = 'U'.repeat(58);
const OLD = { ...process.env };
beforeEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  Object.assign(process.env, ENV);
});
afterEach(() => (process.env = { ...OLD }));

describe('onInvestConfig', () => {
  it('is OFF by default', () => {
    expect(onInvestConfig({}).enabled).toBe(false);
    const { TOKENIZE_ON_INVEST_ENABLED, ...rest } = ENV;
    void TOKENIZE_ON_INVEST_ENABLED;
    expect(onInvestConfig(rest).enabled).toBe(false);
    expect(onInvestConfig(rest).missing).toContain(
      'TOKENIZE_ON_INVEST_ENABLED',
    );
  });
  it('stays TestNet-only', () => {
    expect(
      onInvestConfig({ ...ENV, ALGORAND_NETWORK: 'mainnet' }).enabled,
    ).toBe(false);
  });
  it('on with all vars; delivery needs chain wallets', () => {
    expect(onInvestConfig(ENV)).toMatchObject({
      enabled: true,
      delivery: true,
    });
    const { CHAIN_WALLETS_ENABLED, ...noW } = ENV;
    void CHAIN_WALLETS_ENABLED;
    expect(onInvestConfig(noW)).toMatchObject({
      enabled: true,
      delivery: false,
    });
  });
  it('unitsFor floors to whole FARM', () => {
    expect(unitsFor(100.99)).toBe(100n);
    expect(unitsFor(0.5)).toBe(0n);
  });
});

function svcMocks(o: any = {}) {
  const tx: any = {
    project_tokens: { update: jest.fn() },
    blockchain_transactions: { create: jest.fn() },
    project_reviews: { create: jest.fn() },
  };
  const project = {
    id: PID,
    status: 'draft',
    target_amount: 5000,
    raised_amount: 0,
    token: null,
    ...o.project,
  };
  const prisma: any = {
    investment_projects: { findFirst: jest.fn().mockResolvedValue(project) },
    project_tokens: {
      create: jest.fn((a: any) => ({ id: 't1', ...a.data })),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: o.claim ?? 1 }),
      findUnique: jest.fn(async (a: any) =>
        a.select
          ? { mode: 'on_invest' }
          : (o.token ?? {
              id: 't1',
              project_id: PID,
              mode: 'on_invest',
              status: 'requested',
              asset_name: 'Solar',
              unit_name: 'SOLAR',
              accept_buyback_commitment: true,
              network: 'testnet',
              unit_price: 1,
              total_units: 0n,
              project,
            }),
      ),
    },
    token_allocations: { groupBy: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((fn: any) => fn(tx)),
  };
  const access: any = {
    resolve: jest.fn().mockResolvedValue({ business: { id: 'b1' } }),
  };
  const chain: any = {
    createAsset: jest.fn().mockResolvedValue({
      assetId: 777n,
      txId: 'CREATE',
      confirmedRound: 9n,
      issuer: 'ISSUER',
    }),
  };
  return {
    svc: new TokenizationService(prisma, access, chain),
    prisma,
    chain,
    tx,
  };
}

describe('business request (on_invest)', () => {
  const dto = {
    asset_name: 'Solar',
    unit_name: 'solar',
    accept_buyback_commitment: true,
    mode: 'on_invest',
  };
  it('refused when the flag is off', async () => {
    delete process.env.TOKENIZE_ON_INVEST_ENABLED;
    await expect(svcMocks().svc.request('u', PID, dto)).rejects.toThrow(
      BadRequestException,
    );
  });
  it('accepted at draft, stored as on_invest', async () => {
    const { svc, prisma } = svcMocks();
    const r = await svc.request('u', PID, dto);
    expect(r.data.mode).toBe('on_invest');
    expect(r.data.unit_name).toBe('SOLAR');
    expect(prisma.project_tokens.create).toHaveBeenCalled();
  });
  it('refused once listed', async () => {
    await expect(
      svcMocks({ project: { status: 'listed' } }).svc.request('u', PID, dto),
    ).rejects.toThrow('before the project is listed');
  });
  it('legacy post-funding path unchanged', async () => {
    await expect(
      svcMocks().svc.request('u', PID, {
        asset_name: 'S',
        unit_name: 'S',
        accept_buyback_commitment: true,
      }),
    ).rejects.toThrow('Only funded or closed');
  });
});

describe('mintOnInvest / listing', () => {
  it('creates the ASA with supply = funding target, issuer holds all', async () => {
    const { svc, chain, tx } = svcMocks({ project: { status: 'approved' } });
    await svc.mintOnInvest('admin', 't1');
    expect(chain.createAsset).toHaveBeenCalledWith(
      expect.objectContaining({ total: 5000n }),
    );
    expect(tx.project_tokens.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'created',
          total_units: 5000n,
        }),
      }),
    );
  });
  it('approveAndMint routes on_invest tokens to mintOnInvest', async () => {
    const { svc, chain } = svcMocks({ project: { status: 'approved' } });
    await svc.approveAndMint('admin', 't1');
    expect(chain.createAsset).toHaveBeenCalledWith(
      expect.objectContaining({ total: 5000n }),
    );
  });
  it('never mints when investments already exist', async () => {
    const { svc, chain } = svcMocks({
      project: { status: 'listed', raised_amount: 10 },
    });
    await expect(svc.mintOnInvest('admin', 't1')).rejects.toThrow(
      BadRequestException,
    );
    expect(chain.createAsset).not.toHaveBeenCalled();
  });
  it('refused when the flag is off', async () => {
    delete process.env.TOKENIZE_ON_INVEST_ENABLED;
    const { svc, chain } = svcMocks({ project: { status: 'approved' } });
    await expect(svc.mintOnInvest('admin', 't1')).rejects.toThrow();
    expect(chain.createAsset).not.toHaveBeenCalled();
  });
  it('ensureTokenForListing: no token -> no-op; created -> no mint', async () => {
    const a = svcMocks();
    a.prisma.project_tokens.findUnique.mockResolvedValueOnce(null);
    expect(await a.svc.ensureTokenForListing('admin', PID)).toBeNull();
    const b = svcMocks();
    b.prisma.project_tokens.findUnique.mockResolvedValueOnce({
      id: 't1',
      mode: 'on_invest',
      status: 'created',
    });
    await b.svc.ensureTokenForListing('admin', PID);
    expect(b.chain.createAsset).not.toHaveBeenCalled();
  });
});

describe('allocateOnInvestInTx', () => {
  const tx = (token: any, used = 0n) => ({
    project_tokens: { findUnique: jest.fn().mockResolvedValue(token) },
    token_allocations: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { units: used } }),
      create: jest.fn((a: any) => a.data),
    },
  });
  const p = { projectId: PID, investmentId: 'i1', userId: 'u1', amount: 250.7 };
  const T = {
    id: 't1',
    mode: 'on_invest',
    status: 'created',
    total_units: 1000n,
  };
  it('records an owed allocation of whole FARM units', async () => {
    const t = tx(T);
    const r = await allocateOnInvestInTx(t, p);
    expect(r).toMatchObject({ units: 250n, status: 'owed', user_id: 'u1' });
  });
  it('skips projects without an on-invest token', async () => {
    expect(await allocateOnInvestInTx(tx(null), p)).toBeNull();
    expect(
      await allocateOnInvestInTx(tx({ ...T, mode: 'post_funding' }), p),
    ).toBeNull();
  });
  it('never exceeds total supply (rolls back the investment)', async () => {
    await expect(allocateOnInvestInTx(tx(T, 900n), p)).rejects.toThrow(
      ConflictException,
    );
  });
});

function deliveryMocks(o: any = {}) {
  const alloc = {
    id: 'a1',
    status: 'owed',
    user_id: 'u1',
    units: 100n,
    address: o.address ?? null,
    token: {
      id: 't1',
      asset_id: 777n,
      network: 'testnet',
      mode: 'on_invest',
      total_units: 1000n,
      project: { status: o.projectStatus ?? 'listed' },
    },
    ...o.alloc,
  };
  const prisma: any = {
    token_allocations: {
      findUnique: jest.fn().mockResolvedValue(alloc),
      findMany: jest.fn().mockResolvedValue(o.rows ?? []),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: o.claim ?? 1 }),
      aggregate: jest.fn().mockResolvedValue({ _sum: { units: o.sold ?? 0n } }),
    },
    token_buybacks: { count: jest.fn().mockResolvedValue(0) },
    user_chain_wallets: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          o.wallet === undefined
            ? { address: ADDR, status: 'ready', network: 'testnet' }
            : o.wallet,
        ),
    },
    project_tokens: {
      findUnique: jest.fn().mockResolvedValue({
        id: 't1',
        mode: 'on_invest',
        status: 'created',
        total_units: 1000n,
      }),
      update: jest.fn(),
    },
  };
  const send = jest.fn().mockResolvedValue(undefined);
  const chain: any = {
    isOptedIn: jest.fn().mockResolvedValue(o.optedIn ?? true),
    optIn: jest.fn().mockResolvedValue('OPT'),
    prepareFarmTransfer: jest
      .fn()
      .mockResolvedValue({ txId: 'TX', lastValid: 10n, send }),
    prepareClawback: jest
      .fn()
      .mockResolvedValue({ txId: 'CB', lastValid: 10n, send }),
    txStatus: jest.fn().mockResolvedValue(o.txStatus ?? 'unknown'),
    currentRound: jest.fn().mockResolvedValue(o.round ?? 5n),
  };
  const asa: any = {
    issuerSigner: jest.fn(() => ({ address: 'ISSUER', wipe: jest.fn() })),
  };
  const topup: any = {
    ensure: jest.fn().mockResolvedValue(o.topup ?? 'sent'),
  };
  return {
    svc: new TokenDeliveryService(prisma, chain, asa, topup),
    prisma,
    chain,
    topup,
    send,
  };
}

describe('TokenDeliveryService', () => {
  it('disabled by default -> nothing', async () => {
    delete process.env.TOKENIZE_ON_INVEST_ENABLED;
    const m = deliveryMocks();
    expect(await m.svc.deliverOne('a1')).toBe('disabled');
    await m.svc.tick();
    expect(m.chain.prepareFarmTransfer).not.toHaveBeenCalled();
  });
  it('no ready in-app wallet -> stays owed', async () => {
    const m = deliveryMocks({ wallet: null });
    expect(await m.svc.deliverOne('a1')).toBe('owed_no_wallet');
    expect(m.chain.prepareFarmTransfer).not.toHaveBeenCalled();
  });
  it('wallet on another network -> stays owed', async () => {
    const m = deliveryMocks({
      wallet: { address: ADDR, status: 'ready', network: 'mainnet' },
    });
    expect(await m.svc.deliverOne('a1')).toBe('owed_no_wallet');
  });
  it('delivers: claims, stores txId BEFORE sending, then marks delivered', async () => {
    const m = deliveryMocks();
    expect(await m.svc.deliverOne('a1')).toBe('delivered');
    const order = m.prisma.token_allocations.update.mock.calls.map(
      (c: any) => c[0].data,
    );
    expect(order[0]).toEqual({ tx_id: 'TX', last_valid: 10n });
    expect(order[1]).toMatchObject({ status: 'delivered' });
    expect(
      m.prisma.token_allocations.update.mock.invocationCallOrder[0],
    ).toBeLessThan(m.send.mock.invocationCallOrder[0]);
    expect(m.chain.prepareFarmTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ to: ADDR, amount: 100n, assetId: 777n }),
    );
  });
  it('already claimed elsewhere -> in_flight, no send', async () => {
    const m = deliveryMocks({ claim: 0 });
    expect(await m.svc.deliverOne('a1')).toBe('in_flight');
    expect(m.send).not.toHaveBeenCalled();
  });
  it('opts in via the capped top-up first', async () => {
    const m = deliveryMocks({ optedIn: false });
    jest
      .spyOn(vault, 'walletSigner')
      .mockReturnValue({ wipe: jest.fn() } as any);
    expect(await m.svc.deliverOne('a1')).toBe('delivered');
    expect(m.topup.ensure).toHaveBeenCalledWith(ADDR, 'token_optin', 101_000n);
    expect(m.chain.optIn).toHaveBeenCalled();
  });
  it('top-up capped -> stays owed, no opt-in, no send', async () => {
    const m = deliveryMocks({ optedIn: false, topup: 'wallet_cap' });
    expect(await m.svc.deliverOne('a1')).toBe('owed_no_algo');
    expect(m.chain.optIn).not.toHaveBeenCalled();
    expect(m.send).not.toHaveBeenCalled();
  });
  it('cancelled project -> never delivered', async () => {
    const m = deliveryMocks({ projectStatus: 'cancelled' });
    expect(await m.svc.deliverOne('a1')).toBe('skip');
  });
  it('resolveStuck: confirmed -> delivered, expired -> owed, cancelled -> clawback', async () => {
    const row = (s: any) => ({
      id: 'a1',
      status: 'sending',
      tx_id: 'TX',
      last_valid: 3n,
      token: { project: { status: s } },
    });
    let m = deliveryMocks({ rows: [row('listed')], txStatus: 'confirmed' });
    await m.svc.resolveStuck();
    expect(
      m.prisma.token_allocations.updateMany.mock.calls[0][0].data.status,
    ).toBe('delivered');
    m = deliveryMocks({
      rows: [row('listed')],
      txStatus: 'unknown',
      round: 9n,
    });
    await m.svc.resolveStuck();
    expect(
      m.prisma.token_allocations.updateMany.mock.calls[0][0].data.status,
    ).toBe('owed');
    m = deliveryMocks({ rows: [row('cancelled')], txStatus: 'confirmed' });
    await m.svc.resolveStuck();
    expect(
      m.prisma.token_allocations.updateMany.mock.calls[0][0].data.status,
    ).toBe('clawback_pending');
  });
  it('unwindForCancel: cancels owed and claws back delivered', async () => {
    const m = deliveryMocks({
      alloc: { status: 'clawback_pending', address: ADDR },
      rows: [{ id: 'a1' }],
    });
    const r = await m.svc.unwindForCancel(PID);
    expect(
      m.prisma.token_allocations.updateMany.mock.calls[0][0],
    ).toMatchObject({
      where: { status: 'owed' },
      data: { status: 'cancelled' },
    });
    expect(m.chain.prepareClawback).toHaveBeenCalledWith(
      expect.objectContaining({ from: ADDR, to: 'ISSUER', amount: 100n }),
    );
    expect(r.clawed_back).toBe(1);
  });
  it('closeOnInvest records unsold supply', async () => {
    const m = deliveryMocks({ sold: 640n });
    expect(await m.svc.closeOnInvest(PID)).toEqual({
      sold: '640',
      unsold: '360',
    });
    expect(m.prisma.project_tokens.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ unsold_units: 360n }),
      }),
    );
  });
});
