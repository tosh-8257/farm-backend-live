import { randomBytes } from 'crypto';
import { ChainWalletService } from './chain-wallet.service';

const RES = 'R'.repeat(58);
const ENV: Record<string, string> = {
  CHAIN_WALLETS_ENABLED: 'true',
  CHAIN_DEPOSITS_ENABLED: 'true',
  ALGORAND_NETWORK: 'testnet',
  ALGORAND_NODE_URL: 'https://node.example',
  ALGORAND_INDEXER_URL: 'https://idx.example',
  ALGORAND_FUNDER_MNEMONIC: 'x',
  FARM_RESERVE_ADDRESS: RES,
  WALLET_KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  USDC_ASA_ID: '10458941',
  FARM_ASA_ID: '42',
};
const OLD = { ...process.env };
beforeEach(() => Object.assign(process.env, ENV));
afterEach(() => {
  process.env = { ...OLD };
  jest.restoreAllMocks();
});

const t = (txId: string, sender: string, receiver: string, amount: bigint) => ({
  txId,
  assetId: 42n,
  sender,
  receiver,
  amount,
  round: 20n,
});

function svc(transfers: any[] = [], pending: any[] = []) {
  const tx: any = {
    chain_deposits: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn(),
    },
    wallets: {
      findFirst: jest.fn((a: any) =>
        Promise.resolve(a.where.id ? { id: a.where.id } : { id: 'personal' }),
      ),
      update: jest.fn(),
    },
    transactions: { create: jest.fn().mockResolvedValue({ id: 't1' }) },
    ledger_entries: { create: jest.fn() },
    blockchain_transactions: { create: jest.fn() },
  };
  const prisma: any = {
    user_chain_wallets: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { address: 'U1', user_id: 'u1', funded_tx_id: 'FU' },
        ]),
    },
    business_chain_wallets: {
      findMany: jest.fn().mockResolvedValue([
        {
          address: 'B1',
          business_id: 'b1',
          wallet_id: 'bw1',
          funded_tx_id: 'FB',
        },
      ]),
    },
    businesses: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'b1', owner_user_id: 'owner1' }]),
    },
    chain_sync_state: {
      findUnique: jest.fn().mockResolvedValue({ key: 'k', last_round: 10n }),
      create: jest.fn(),
      update: jest.fn(),
    },
    chain_deposits: {
      createMany: jest.fn((a: any) => ({ count: a.data.length })),
      findMany: jest.fn().mockResolvedValue(pending),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn((fn: any) => fn(tx)),
  };
  const chain: any = {
    transfersSince: jest.fn((asset: bigint) =>
      Promise.resolve(
        transfers.filter((x: any) => (x.assetId ?? 42n) === asset),
      ),
    ),
    currentRound: jest.fn().mockResolvedValue(900n),
    funderAddress: jest.fn(() => 'FUNDER'),
    paymentsTo: jest.fn().mockResolvedValue([]),
  };
  const rates: any = {
    usdcKes: jest
      .fn()
      .mockResolvedValue({ rate: 130, source: 'test', at: new Date() }),
    algoKes: jest.fn(),
  };
  const notifications: any = {
    createInApp: jest.fn().mockResolvedValue({}),
    sendPush: jest.fn().mockResolvedValue(true),
  };
  return {
    s: new ChainWalletService(prisma, chain, rates, notifications),
    prisma,
    tx,
    notifications,
  };
}
const rows = (prisma: any) =>
  prisma.chain_deposits.createMany.mock.calls.flatMap((c: any) => c[0].data);

describe('business account deposits', () => {
  it('flag off: business addresses are not scanned', async () => {
    delete process.env.BUSINESS_WALLET_ENABLED;
    const { s, prisma } = svc([t('X', 'PERA', 'B1', 100n)]);
    await s.pollDeposits();
    expect(rows(prisma)).toEqual([]);
    expect(prisma.business_chain_wallets.findMany).not.toHaveBeenCalled();
  });

  it('flag on: records outside FARM to a business address for the business wallet; ignores internal senders', async () => {
    process.env.BUSINESS_WALLET_ENABLED = 'true';
    const { s, prisma } = svc([
      t('X', 'PERA', 'B1', 100n),
      t('R', RES, 'B1', 100n),
      t('I', 'U1', 'B1', 100n),
      t('S', 'B1', 'B1', 100n),
      t('P', 'PERA', 'U1', 100n),
    ]);
    await s.pollDeposits();
    expect(
      rows(prisma).map((r: any) => [r.tx_id, r.user_id, r.business_wallet_id]),
    ).toEqual([
      ['X', 'owner1', 'bw1'],
      ['P', 'u1', null],
    ]);
    expect(
      prisma.chain_deposits.createMany.mock.calls[0][0].skipDuplicates,
    ).toBe(true);
  });

  it('credits the business wallet (not personal) and notifies the owner once', async () => {
    process.env.BUSINESS_WALLET_ENABLED = 'true';
    const d = {
      id: 'd1',
      asset_symbol: 'FARM',
      status: 'detected',
      amount_units: 1500n,
      decimals: 2,
      tx_id: 'X',
      asset_id: 42n,
      confirmed_round: 5n,
      network: 'testnet',
      user_id: 'owner1',
      business_wallet_id: 'bw1',
      sender: 'PERA',
      address: 'B1',
    };
    const { s, tx, notifications } = svc([], [d]);
    expect(await s.creditPending()).toEqual({ credited: 1, waiting: 0 });
    expect(tx.wallets.findFirst.mock.calls[0][0].where).toEqual({
      id: 'bw1',
      wallet_type: 'merchant',
    });
    expect(tx.wallets.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'bw1' },
      data: { balance: { increment: 15 } },
    });
    expect(tx.transactions.create.mock.calls[0][0].data.metadata).toMatchObject(
      {
        chain_settled: true,
        business_wallet: true,
      },
    );
    expect(notifications.createInApp).toHaveBeenCalledTimes(1);
    expect(notifications.createInApp.mock.calls[0][0]).toBe('owner1');

    // Already claimed (idempotent by tx id/status): no second credit or notification.
    tx.chain_deposits.updateMany.mockResolvedValue({ count: 0 });
    expect((await s.creditPending()).credited).toBe(0);
    expect(notifications.createInApp).toHaveBeenCalledTimes(1);
  });
  it('USDC: scans only business accounts opted in to USDC, credited at the live rate to the business wallet', async () => {
    process.env.BUSINESS_WALLET_ENABLED = 'true';
    process.env.CHAIN_USDC_CONVERSION_ENABLED = 'true';
    const { s, prisma } = svc([
      { ...t('U', 'PERA', 'B1', 2_000_000n), assetId: 10458941n },
    ]);
    await s.pollDeposits();
    const usdcCall = prisma.business_chain_wallets.findMany.mock.calls.find(
      (c: any) => c[0].where.usdc_opt_in_tx,
    );
    expect(usdcCall[0].where.usdc_opt_in_tx).toEqual({ not: null });
    expect(
      rows(prisma).map((r: any) => [
        r.tx_id,
        r.asset_symbol,
        r.business_wallet_id,
      ]),
    ).toEqual([['U', 'USDC', 'bw1']]);
  });
});
