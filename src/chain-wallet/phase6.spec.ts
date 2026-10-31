import { ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { chainConfig } from './chain-config';
import { openSecret, sealSecret } from './key-vault';
import { ChainWalletService } from './chain-wallet.service';
import { reconcileMode } from './chain-wallet.controller';
import { SafeInputValidationPipe } from '../common/pipes/safe-input.pipe';
import { BadRequestException } from '@nestjs/common';
import { RateService } from './rate.service';

const KEY = randomBytes(32).toString('base64');
const ENV: Record<string, string> = {
  CHAIN_WALLETS_ENABLED: 'true',
  ALGORAND_NETWORK: 'testnet',
  ALGORAND_NODE_URL: 'https://node.example',
  ALGORAND_INDEXER_URL: 'https://idx.example',
  ALGORAND_FUNDER_MNEMONIC: 'x',
  FARM_RESERVE_ADDRESS: 'R'.repeat(58),
  WALLET_KEY_ENCRYPTION_KEY: KEY,
  USDC_ASA_ID: '10458941',
  FARM_ASA_ID: '42',
};

describe('Phase 6 – config', () => {
  it('everything off with nothing set; only names reported', () => {
    const c = chainConfig({});
    expect(
      c.wallets.enabled ||
        c.deposits.enabled ||
        c.conversion.enabled ||
        c.mirror.enabled,
    ).toBe(false);
    expect(c.wallets.missing).toContain('WALLET_KEY_ENCRYPTION_KEY');
  });
  it('mainnet refused unless explicitly allowed', () => {
    expect(
      chainConfig({ ...ENV, ALGORAND_NETWORK: 'mainnet' }).wallets.enabled,
    ).toBe(false);
    expect(
      chainConfig({
        ...ENV,
        ALGORAND_NETWORK: 'mainnet',
        ALGORAND_ALLOW_MAINNET: 'true',
      }).wallets.enabled,
    ).toBe(true);
  });
  it('rejects a short master key and never echoes secrets', () => {
    const c = chainConfig({
      ...ENV,
      WALLET_KEY_ENCRYPTION_KEY: 'c2hvcnQ=',
      ALGORAND_ISSUER_MNEMONIC: 'secret words',
    });
    expect(c.wallets.enabled).toBe(false);
    expect(JSON.stringify(c)).not.toMatch(/secret words|c2hvcnQ/);
  });
  it('conversion needs an https rate source', () => {
    expect(chainConfig(ENV).conversion.enabled).toBe(false);
    expect(
      chainConfig({
        ...ENV,
        USDC_KES_RATE_URL: 'https://r',
        USDC_KES_RATE_JSON_PATH: 'a',
      }).conversion.enabled,
    ).toBe(true);
  });
});

describe('Phase 6 – key vault', () => {
  it('round-trips, is bound to the address, and fails with another key', () => {
    const sk = randomBytes(64);
    const env = { WALLET_KEY_ENCRYPTION_KEY: KEY };
    const sealed = sealSecret(sk, 'ADDR', env);
    expect(sealed.enc_secret).not.toContain(sk.toString('base64'));
    expect(Buffer.from(openSecret(sealed, 'ADDR', env))).toEqual(sk);
    expect(() => openSecret(sealed, 'OTHER', env)).toThrow();
    expect(() =>
      openSecret(sealed, 'ADDR', {
        WALLET_KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      }),
    ).toThrow();
  });
});

describe('Phase 6 – rate source', () => {
  afterEach(() => jest.restoreAllMocks());
  it('no URL => no rate (never invented)', async () => {
    expect(await new RateService().usdcKes({})).toBeNull();
  });
  it('reads the configured JSON path and rejects out-of-bounds values', async () => {
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { KES: 129.4 } }),
    } as any);
    expect(
      (
        await new RateService().usdcKes({
          USDC_KES_RATE_URL: 'https://rates.example/x',
          USDC_KES_RATE_JSON_PATH: 'data.KES',
        })
      )?.rate,
    ).toBe(129.4);
    jest.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ data: { KES: 1 } }),
    } as any);
    expect(
      await new RateService().usdcKes({
        USDC_KES_RATE_URL: 'https://rates.example/x',
        USDC_KES_RATE_JSON_PATH: 'data.KES',
      }),
    ).toBeNull();
  });
});

function mocks(over: any = {}) {
  const tx: any = {
    chain_deposits: {
      updateMany: jest.fn().mockResolvedValue({ count: over.claim ?? 1 }),
      update: jest.fn(),
    },
    wallets: {
      findFirst: jest.fn().mockResolvedValue({ id: 'w1' }),
      update: jest.fn(),
    },
    transactions: { create: jest.fn().mockResolvedValue({ id: 't1' }) },
    ledger_entries: { create: jest.fn() },
    blockchain_transactions: { create: jest.fn() },
  };
  const prisma: any = {
    user_chain_wallets: {
      findUnique: jest.fn().mockResolvedValue(over.wallet ?? null),
      create: jest.fn((a: any) => ({
        id: 'cw1',
        status: 'created',
        ...a.data,
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest
        .fn()
        .mockResolvedValue([{ address: 'USERADDR', user_id: 'u1' }]),
    },
    chain_sync_state: {
      findUnique: jest.fn().mockResolvedValue({ key: 'k', last_round: 100n }),
      create: jest.fn(),
      update: jest.fn(),
    },
    chain_deposits: {
      createMany: jest.fn((a: any) => ({ count: a.data.length })),
      findMany: jest.fn().mockResolvedValue(over.pending ?? []),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn((fn: any) => fn(tx)),
  };
  const chain: any = {
    newAccount: jest.fn(() => ({
      address: 'NEWADDR',
      seed: new Uint8Array(32).fill(7),
      scheme: 'falcon1024',
    })),
    transfersSince: jest.fn((asset: bigint) =>
      Promise.resolve(
        asset === 42n ? (over.farmTransfers ?? []) : (over.transfers ?? []),
      ),
    ),
    currentRound: jest.fn().mockResolvedValue(100n),
    funderAddress: jest.fn(() => 'FUNDER'),
    paymentsTo: jest.fn().mockResolvedValue([]),
  };
  const rates: any = {
    usdcKes: jest.fn().mockResolvedValue(over.rate ?? null),
  };
  return {
    svc: new ChainWalletService(prisma, chain, rates),
    prisma,
    chain,
    tx,
    rates,
  };
}

describe('Phase 6 – custodial wallet + deposits', () => {
  const OLD = { ...process.env };
  beforeEach(() => Object.assign(process.env, ENV));
  afterEach(() => (process.env = { ...OLD }));

  it('disabled => no wallet is created', async () => {
    delete process.env.WALLET_KEY_ENCRYPTION_KEY;
    const { svc, prisma } = mocks();
    expect(await svc.mine('u1')).toEqual({ data: null, enabled: false });
    expect(prisma.user_chain_wallets.create).not.toHaveBeenCalled();
  });
  it('creates an encrypted wallet and never returns key material', async () => {
    const { svc, prisma } = mocks();
    const r: any = await svc.mine('u1');
    const stored = prisma.user_chain_wallets.create.mock.calls[0][0].data;
    expect(stored.enc_secret).toBeDefined();
    expect(Buffer.from(stored.enc_secret, 'base64')).not.toEqual(
      Buffer.alloc(32, 7),
    );
    expect(stored.key_scheme).toBe('falcon1024');
    expect(r.data.address).toBe('NEWADDR');
    expect(JSON.stringify(r)).not.toMatch(/enc_|secret/);
  });
  it('records only transfers into FARM addresses, skipping opt-ins; duplicates are skipped', async () => {
    process.env.CHAIN_DEPOSITS_ENABLED = 'true';
    const { svc, prisma } = mocks({
      transfers: [
        {
          txId: 'A',
          assetId: 10458941n,
          sender: 'EXT',
          receiver: 'USERADDR',
          amount: 5_000_000n,
          round: 120n,
        },
        {
          txId: 'B',
          assetId: 10458941n,
          sender: 'USERADDR',
          receiver: 'USERADDR',
          amount: 0n,
          round: 121n,
        },
        {
          txId: 'C',
          assetId: 10458941n,
          sender: 'EXT',
          receiver: 'STRANGER',
          amount: 1n,
          round: 122n,
        },
      ],
    });
    const r = await svc.pollUsdc();
    const call = prisma.chain_deposits.createMany.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true);
    expect(call.data.map((d: any) => d.tx_id)).toEqual(['A']);
    expect(r.recorded).toBe(1);
    expect(
      prisma.chain_sync_state.update.mock.calls[0][0].data.last_round,
    ).toBe(122n);
  });
  it('without a rate, deposits wait (pending_rate) and nothing is credited', async () => {
    const { svc, prisma, tx } = mocks({
      pending: [
        { id: 'd1', status: 'detected', amount_units: 5_000_000n, decimals: 6 },
      ],
    });
    expect(await svc.creditPending()).toEqual({ credited: 0, waiting: 1 });
    expect(prisma.chain_deposits.updateMany.mock.calls[0][0].data.status).toBe(
      'pending_rate',
    );
    expect(tx.wallets.update).not.toHaveBeenCalled();
  });
  it('credits FARM = USDC x KSh rate once, with ledger + chain record', async () => {
    Object.assign(process.env, {
      USDC_KES_RATE_URL: 'https://r',
      USDC_KES_RATE_JSON_PATH: 'a',
    });
    const d = {
      id: 'd1',
      asset_symbol: 'USDC',
      status: 'pending_rate',
      amount_units: 5_000_000n,
      decimals: 6,
      tx_id: 'A',
      asset_id: 1n,
      confirmed_round: 1n,
      network: 'testnet',
      user_id: 'u1',
    };
    const { svc, tx } = mocks({
      pending: [d],
      rate: { rate: 129.37, source: 'r', at: new Date() },
    });
    expect((await svc.creditPending()).credited).toBe(1);
    expect(tx.wallets.update.mock.calls[0][0].data.balance.increment).toBe(
      646.85,
    );
    expect(tx.ledger_entries.create).toHaveBeenCalled();
    expect(
      tx.blockchain_transactions.create.mock.calls[0][0].data.tx_hash,
    ).toBe('A');
    const again = mocks({
      pending: [d],
      rate: { rate: 129.37, source: 'r', at: new Date() },
      claim: 0,
    });
    expect((await again.svc.creditPending()).credited).toBe(0);
    expect(again.tx.wallets.update).not.toHaveBeenCalled();
  });
  it('reconcile execute is refused unless the mirror flag is on', async () => {
    await expect(mocks().svc.reconcile('a', 'execute')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
  it('reconcile mode=send maps to the real mode; execute kept; else dry', () => {
    expect(reconcileMode('send')).toBe('execute');
    expect(reconcileMode('execute')).toBe('execute');
    expect(reconcileMode('dry')).toBe('dry');
    expect(reconcileMode(undefined)).toBe('dry');
    expect(reconcileMode('SEND')).toBe('dry');
  });
  it('mode=send passes the input filter (execute does not)', () => {
    const pipe = new SafeInputValidationPipe();
    expect(pipe.transform('send', { type: 'query', data: 'mode' })).toBe(
      'send',
    );
    expect(() =>
      pipe.transform('execute', { type: 'query', data: 'mode' }),
    ).toThrow(BadRequestException);
  });
  it('reconcile send is still refused unless the mirror flag is on', async () => {
    await expect(
      mocks().svc.reconcile('a', reconcileMode('send'), 1, 'A'.repeat(58)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
  it('reconcile rejects a malformed address', async () => {
    await expect(
      mocks().svc.reconcile('a', 'dry', 1, 'not-an-address'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  it('reconcile with address only queries that ready wallet', async () => {
    const m = mocks();
    (m as any).prisma.farm_reconciliation_runs = {
      create: jest.fn().mockResolvedValue({ id: 'run1' }),
      update: jest.fn(),
    };
    await m.svc.reconcile('a', 'dry', 1, 'A'.repeat(58)).catch(() => undefined);
    const where = (m as any).prisma.user_chain_wallets.findMany.mock.calls[0][0]
      .where;
    expect(where).toMatchObject({ status: 'ready', address: 'A'.repeat(58) });
  });
});
