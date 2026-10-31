import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TokenizationService } from './tokenization.service';
import { algorandConfig } from './algorand-config';

const PID = '11111111-1111-1111-1111-111111111111';
const ENV = {
  TOKENIZATION_ENABLED: 'true',
  ALGORAND_NETWORK: 'testnet',
  ALGORAND_NODE_URL: 'https://testnet-api.example',
  ALGORAND_ISSUER_MNEMONIC: 'x',
};

function mocks(over: any = {}) {
  const tx: any = {
    project_tokens: { update: jest.fn() },
    token_allocations: { createMany: jest.fn() },
    blockchain_transactions: { create: jest.fn() },
    project_reviews: { create: jest.fn() },
  };
  const prisma: any = {
    investment_projects: {
      findFirst: jest.fn().mockResolvedValue(
        over.project ?? {
          id: PID,
          status: 'funded',
          raised_amount: 800,
          token: null,
        },
      ),
    },
    project_tokens: {
      create: jest.fn((a: any) => ({ id: 't1', ...a.data })),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: over.claim ?? 1 }),
      findUnique: jest.fn().mockResolvedValue(
        over.token ?? {
          id: 't1',
          project_id: PID,
          asset_name: 'Solar',
          unit_name: 'SOLAR',
          accept_buyback_commitment: true,
          network: 'testnet',
          unit_price: 1,
          total_units: 0n,
          project: { status: 'funded' },
        },
      ),
    },
    user_investments: {
      findMany: jest.fn().mockResolvedValue(
        over.investments ?? [
          { id: 'i1', user_id: 'u1', amount: 500.7 },
          { id: 'i2', user_id: 'u2', amount: 300 },
        ],
      ),
    },
    token_allocations: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((fn: any) => fn(tx)),
  };
  const access: any = {
    resolve: jest.fn().mockResolvedValue({ business: { id: 'b1' } }),
  };
  const chain: any = {
    createAsset:
      over.createAsset ??
      jest.fn().mockResolvedValue({
        assetId: 7n,
        txId: 'REALTXID',
        confirmedRound: 99n,
        issuer: 'ISSUER',
      }),
  };
  return {
    svc: new TokenizationService(prisma, access, chain),
    prisma,
    tx,
    chain,
    access,
  };
}

describe('Phase 5 – Algorand config', () => {
  it('is disabled and lists missing variable NAMES only when nothing is set', () => {
    const c = algorandConfig({});
    expect(c.enabled).toBe(false);
    expect(c.missing).toEqual([
      'TOKENIZATION_ENABLED',
      'ALGORAND_NETWORK',
      'ALGORAND_NODE_URL',
      'ALGORAND_ISSUER_MNEMONIC',
    ]);
  });
  it('refuses mainnet and non-https nodes; never echoes secret values', () => {
    const c = algorandConfig({
      ...ENV,
      ALGORAND_NETWORK: 'mainnet',
      ALGORAND_NODE_URL: 'http://x',
      ALGORAND_ISSUER_MNEMONIC: 'secret words',
    });
    expect(c.enabled).toBe(false);
    expect(JSON.stringify(c)).not.toContain('secret words');
  });
  it('is enabled on testnet with all vars', () =>
    expect(algorandConfig(ENV).enabled).toBe(true));
});

describe('Phase 5 – tokenization flow', () => {
  const OLD = { ...process.env };
  afterEach(() => (process.env = { ...OLD }));

  it('business can request only for funded/closed projects with valid names', async () => {
    await expect(
      mocks({
        project: { id: PID, status: 'listed', raised_amount: 5, token: null },
      }).svc.request('u', PID, {
        asset_name: 'A',
        unit_name: 'A',
        accept_buyback_commitment: true,
      }),
    ).rejects.toThrow('funded');
    await expect(
      mocks().svc.request('u', PID, { asset_name: 'A', unit_name: 'bad-unit' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const { svc, access } = mocks();
    const r = await svc.request('u', PID, {
      asset_name: 'Solar',
      unit_name: 'solar',
      accept_buyback_commitment: true,
    });
    expect(r.data.unit_name).toBe('SOLAR');
    await expect(
      mocks().svc.request('u', PID, { asset_name: 'Solar', unit_name: 'SOL' }),
    ).rejects.toThrow(/15% buyback commitment/);
    expect(access.resolve).toHaveBeenCalledWith('u', 'projects:manage');
  });
  it('admin mint is refused (503 + missing names) while not configured, and nothing is claimed', async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    const { svc, prisma, chain } = mocks();
    await expect(svc.approveAndMint('a', 't1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.project_tokens.updateMany).not.toHaveBeenCalled();
    expect(chain.createAsset).not.toHaveBeenCalled();
  });
  it('mints whole units per investment and stores only the confirmed chain result', async () => {
    Object.assign(process.env, ENV);
    const { svc, chain, tx } = mocks();
    await svc.approveAndMint('a', 't1');
    expect(chain.createAsset.mock.calls[0][0].total).toBe(800n);
    expect(tx.project_tokens.update.mock.calls[0][0].data).toMatchObject({
      status: 'created',
      asset_id: 7n,
      create_tx_id: 'REALTXID',
      total_units: 800n,
    });
    expect(
      tx.token_allocations.createMany.mock.calls[0][0].data.map(
        (a: any) => a.units,
      ),
    ).toEqual([500n, 300n]);
    expect(
      tx.blockchain_transactions.create.mock.calls[0][0].data.tx_hash,
    ).toBe('REALTXID');
  });
  it('chain failure marks failed without writing any hash or allocation', async () => {
    Object.assign(process.env, ENV);
    const { svc, prisma, tx } = mocks({
      createAsset: jest.fn().mockRejectedValue(new Error('node down')),
    });
    await expect(svc.approveAndMint('a', 't1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(prisma.project_tokens.update.mock.calls[0][0].data).toEqual({
      status: 'failed',
      error: 'node down',
    });
    expect(tx.token_allocations.createMany).not.toHaveBeenCalled();
  });
  it('cannot mint twice (atomic claim)', async () => {
    Object.assign(process.env, ENV);
    await expect(
      mocks({ claim: 0 }).svc.approveAndMint('a', 't1'),
    ).rejects.toThrow('not pending');
  });
});
