import { randomBytes } from 'crypto';
import { ChainWalletService } from './chain-wallet.service';

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
  CHAIN_WALLET_FUND_MICROALGOS: '310000',
};

function harness(spendable = 5_000_000n) {
  const prisma: any = {
    user_chain_wallets: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn((a: any) => ({
        id: 'cw1',
        status: 'created',
        address: a.data.address,
        network: a.data.network,
        ...a.data,
      })),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $queryRaw: jest.fn(async (query: { strings?: string[] }) => {
      const text = (query.strings ?? []).join(' ');
      if (text.includes('users_without_wallet')) {
        return [{ users_without_wallet: 10, with_farm_balance: 4 }];
      }
      return [
        { id: 'u-rich', farm: 80 },
        { id: 'u-zero', farm: 0 },
      ];
    }),
  };
  const chain: any = {
    newAccount: jest.fn(() => ({
      address: 'NEWADDR',
      seed: new Uint8Array(32),
      scheme: 'ed25519',
    })),
    funderAddress: jest.fn(() => 'FUNDER'),
    algoInfo: jest
      .fn()
      .mockResolvedValue({ amount: spendable, minBalance: 0n }),
    fund: jest.fn(),
    optIn: jest.fn(),
  };
  return {
    svc: new ChainWalletService(prisma, chain, {} as any),
    prisma,
    chain,
  };
}

describe('custodial wallet backfill and retry', () => {
  const old = { ...process.env };
  beforeEach(() => {
    process.env = { ...old, ...ENV };
  });
  afterEach(() => {
    process.env = { ...old };
  });

  it('dry mode counts users without a wallet and the ALGO the batch would cost', async () => {
    const { svc, chain } = harness();
    const report = await svc.operatorBackfillWallets({
      mode: 'dry',
      limit: 25,
    });
    expect(report).toMatchObject({
      mode: 'dry',
      enabled: true,
      users_without_wallet: 10,
      with_farm_balance: 4,
      selected: 2,
      selected_with_farm_balance: 1,
      microalgos_each: 310000,
      microalgos_total: 620000,
      funder_spendable_microalgos: 5_000_000,
      funder_enough: true,
    });
    expect(chain.newAccount).not.toHaveBeenCalled();
  });

  it('refuses send without a matching expect-count or a solvent funder', async () => {
    const { svc } = harness();
    await expect(
      svc.operatorBackfillWallets({ mode: 'send', limit: 25 }),
    ).rejects.toThrow(/expect-count/);
    await expect(
      svc.operatorBackfillWallets({
        mode: 'send',
        limit: 25,
        expectCount: 9,
      }),
    ).rejects.toThrow(/does not match/);

    const poor = harness(1000n);
    await expect(
      poor.svc.operatorBackfillWallets({
        mode: 'send',
        limit: 25,
        expectCount: 2,
      }),
    ).rejects.toThrow(/too low/);
    expect(poor.chain.newAccount).not.toHaveBeenCalled();
  });

  it('send provisions the prioritized batch sequentially and stops if ALGO runs out', async () => {
    const { svc } = harness();
    const mine = jest.spyOn(svc, 'mine').mockResolvedValue({
      enabled: true,
      data: {
        address: 'ADDR',
        network: 'testnet',
        status: 'ready',
        ready: true,
        usdc_asa_id: null,
        farm_asa_id: null,
        explorer_url: 'https://example/ADDR',
      },
    });
    const report = await svc.operatorBackfillWallets({
      mode: 'send',
      limit: 25,
      expectCount: 2,
    });
    expect(mine.mock.calls.map((call) => call[0])).toEqual([
      'u-rich',
      'u-zero',
    ]);
    expect(mine.mock.calls[0][1]).toEqual({ awaitProvision: true });
    expect(report).toMatchObject({
      mode: 'send',
      provisioned: 2,
      failed: 0,
      stopped: false,
      addresses: ['ADDR', 'ADDR'],
    });

    const dropping = harness();
    dropping.chain.algoInfo
      .mockResolvedValueOnce({ amount: 1_000_000n, minBalance: 0n })
      .mockResolvedValueOnce({ amount: 1_000_000n, minBalance: 0n })
      .mockResolvedValueOnce({ amount: 400_000n, minBalance: 0n })
      .mockResolvedValueOnce({ amount: 1_000n, minBalance: 0n })
      .mockResolvedValue({ amount: 1_000n, minBalance: 0n });
    const partial = jest.spyOn(dropping.svc, 'mine').mockResolvedValue({
      enabled: true,
      data: {
        address: 'ONE',
        network: 'testnet',
        status: 'ready',
        ready: true,
        usdc_asa_id: null,
        farm_asa_id: null,
        explorer_url: 'https://example/ONE',
      },
    });
    const stopped = await dropping.svc.operatorBackfillWallets({
      mode: 'send',
      limit: 25,
      expectCount: 2,
    });
    expect(partial).toHaveBeenCalledTimes(1);
    expect(stopped).toMatchObject({
      provisioned: 1,
      stopped: true,
      stop_reason: 'funder ALGO balance too low',
    });
  });

  it('does not send when chain wallets are disabled', async () => {
    delete process.env.CHAIN_WALLETS_ENABLED;
    const { svc, chain } = harness();
    const dry = await svc.operatorBackfillWallets({ mode: 'dry', limit: 25 });
    expect(dry.enabled).toBe(false);
    expect(dry.funder_spendable_microalgos).toBeNull();
    await expect(
      svc.operatorBackfillWallets({
        mode: 'send',
        limit: 25,
        expectCount: 2,
      }),
    ).rejects.toThrow(/not enabled/);
    expect(chain.algoInfo).not.toHaveBeenCalled();
  });

  it('retries due created and failed wallets and skips a poor funder', async () => {
    const now = Date.now();
    const { svc, prisma, chain } = harness();
    prisma.user_chain_wallets.findMany.mockResolvedValue([
      {
        id: 'due',
        status: 'failed',
        updated_at: new Date(now - 120_000),
        provision_attempts: 1,
      },
      {
        id: 'fresh',
        status: 'failed',
        updated_at: new Date(now),
        provision_attempts: 1,
      },
      {
        id: 'ready-row',
        status: 'ready',
        updated_at: new Date(0),
        provision_attempts: 0,
      },
    ]);
    const provision = jest.spyOn(svc, 'provision').mockResolvedValue(undefined);
    await svc.retryUnprovisioned();
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledWith('due');

    provision.mockClear();
    chain.algoInfo.mockResolvedValue({ amount: 1_000n, minBalance: 0n });
    await svc.retryUnprovisioned();
    expect(provision).not.toHaveBeenCalled();
  });

  it('awaits provisioning when mine is asked to, and does not create a second wallet', async () => {
    const { svc, prisma } = harness();
    const provision = jest.spyOn(svc, 'provision').mockResolvedValue(undefined);
    prisma.user_chain_wallets.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'cw1',
        status: 'ready',
        address: 'NEWADDR',
        network: 'testnet',
      });
    const created = await svc.mine('u1', { awaitProvision: true });
    expect(provision).toHaveBeenCalledWith('cw1');
    expect(created.data?.ready).toBe(true);
    expect(created.data?.address).toBe('NEWADDR');

    prisma.user_chain_wallets.findUnique.mockResolvedValue({
      id: 'cw1',
      status: 'ready',
      address: 'NEWADDR',
      network: 'testnet',
    });
    prisma.user_chain_wallets.create.mockClear();
    const again = await svc.mine('u1');
    expect(prisma.user_chain_wallets.create).not.toHaveBeenCalled();
    expect(again.data?.address).toBe('NEWADDR');
  });

  it('records a failed provision attempt', async () => {
    const { svc, prisma, chain } = harness();
    prisma.user_chain_wallets.updateMany.mockResolvedValue({ count: 1 });
    prisma.user_chain_wallets.findUnique.mockResolvedValue({
      id: 'cw1',
      address: 'ADDR',
      status: 'provisioning',
      funded_tx_id: null,
      usdc_opt_in_tx: null,
      farm_opt_in_tx: null,
      key_scheme: 'ed25519',
    });
    chain.fund.mockRejectedValue(new Error('node down'));
    await svc.provision('cw1');
    expect(prisma.user_chain_wallets.update).toHaveBeenCalledWith({
      where: { id: 'cw1' },
      data: {
        status: 'failed',
        error: 'node down',
        provision_attempts: { increment: 1 },
      },
    });
  });
});
