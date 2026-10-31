import { randomBytes } from 'crypto';
import { FeeTopupService, topupConfig } from './fee-topup.service';

const ENV: Record<string, string> = {
  CHAIN_WALLETS_ENABLED: 'true',
  ALGORAND_NETWORK: 'testnet',
  ALGORAND_NODE_URL: 'https://node.example',
  ALGORAND_INDEXER_URL: 'https://idx.example',
  ALGORAND_FUNDER_MNEMONIC: 'x',
  FARM_RESERVE_ADDRESS: 'R'.repeat(58),
  WALLET_KEY_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  USDC_ASA_ID: '10458941',
  FARM_ASA_ID: '42',
  ALGO_FEE_TOPUP_ENABLED: 'true',
};
const ADDR = 'U'.repeat(58);

function setup(o: any = {}) {
  const prisma: any = {
    user_chain_wallets: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          o.wallet === undefined
            ? { address: ADDR, user_id: 'u1', status: 'ready' }
            : o.wallet,
        ),
      findMany: jest.fn().mockResolvedValue([{ address: ADDR }]),
    },
    chain_fee_topups: {
      aggregate: jest.fn(({ where }: any) => ({
        _sum: {
          micro_algos: where.address
            ? (o.walletSent ?? 0n)
            : (o.globalSent ?? 0n),
        },
      })),
      create: o.createErr
        ? jest.fn().mockRejectedValue(o.createErr)
        : jest.fn(({ data }: any) => ({ id: 'row1', ...data })),
      update: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ tx_id: 'TX1' }),
      findMany: jest.fn().mockResolvedValue(o.stuck ?? []),
    },
  };
  const send = jest.fn(
    o.sendErr ? () => Promise.reject(new Error('x')) : () => Promise.resolve(),
  );
  const chain: any = {
    algoInfo: jest.fn((a: string) =>
      a === 'FUNDER'
        ? { amount: o.funder ?? 70_000_000n, minBalance: 100_000n }
        : { amount: o.bal ?? 302_000n, minBalance: 300_000n },
    ),
    funderAddress: jest.fn(() => 'FUNDER'),
    prepareFund: jest
      .fn()
      .mockResolvedValue({ txId: 'TX1', lastValid: 10n, send }),
    txStatus: jest.fn().mockResolvedValue(o.txStatus ?? 'unknown'),
    currentRound: jest.fn().mockResolvedValue(o.round ?? 5n),
  };
  return { svc: new FeeTopupService(prisma, chain), prisma, chain, send };
}

describe('ALGO fee top-up', () => {
  const OLD = { ...process.env };
  beforeEach(() => Object.assign(process.env, ENV));
  afterEach(() => (process.env = { ...OLD }));

  it('defaults (microALGO) and env overrides', () => {
    const c = topupConfig({ ...ENV, ALGO_FEE_TOPUP_ENABLED: 'false' });
    expect(c).toMatchObject({
      enabled: false,
      threshold: 5_000n,
      amount: 50_000n,
      perWalletDaily: 200_000n,
      globalDaily: 2_000_000n,
      funderFloor: 5_000_000n,
    });
    expect(topupConfig({ ...ENV, ALGO_FEE_TOPUP_AMOUNT: '0.1' }).amount).toBe(
      100_000n,
    );
  });
  it('is off unless ALGO_FEE_TOPUP_ENABLED=true', async () => {
    process.env.ALGO_FEE_TOPUP_ENABLED = 'false';
    const m = setup();
    expect(await m.svc.ensure(ADDR)).toBe('disabled');
    expect(m.chain.prepareFund).not.toHaveBeenCalled();
  });
  it('tops up a low FARM wallet, stores txId before sending, audit-logs', async () => {
    const m = setup();
    expect(await m.svc.ensure(ADDR)).toBe('sent');
    expect(m.chain.prepareFund).toHaveBeenCalledWith(
      ADDR,
      50_000n,
      'farm:feetopup:row1',
    );
    const calls = m.prisma.chain_fee_topups.update.mock.calls.map(
      (c: any) => c[0].data,
    );
    expect(calls[0]).toMatchObject({ tx_id: 'TX1' });
    expect(calls[1]).toMatchObject({ status: 'sent' });
    expect(
      m.prisma.chain_fee_topups.create.mock.calls[0][0].data,
    ).toMatchObject({
      address: ADDR,
      micro_algos: 50_000n,
      spendable_before: 2_000n,
    });
  });
  it('skips wallets with enough spendable ALGO', async () => {
    const m = setup({ bal: 400_000n });
    expect(await m.svc.ensure(ADDR)).toBe('enough');
  });
  it('never sends to non-FARM addresses or the reserve', async () => {
    expect(await setup({ wallet: null }).svc.ensure(ADDR)).toBe(
      'not_farm_wallet',
    );
    expect(
      await setup({ wallet: { status: 'created', address: ADDR } }).svc.ensure(
        ADDR,
      ),
    ).toBe('not_farm_wallet');
    const m = setup({ wallet: { status: 'ready', address: 'R'.repeat(58) } });
    expect(await m.svc.ensure('R'.repeat(58))).toBe('not_farm_wallet');
    expect(m.chain.prepareFund).not.toHaveBeenCalled();
  });
  it('enforces per-wallet and global daily caps', async () => {
    expect(await setup({ walletSent: 200_000n }).svc.ensure(ADDR)).toBe(
      'wallet_cap',
    );
    expect(await setup({ globalSent: 1_980_000n }).svc.ensure(ADDR)).toBe(
      'global_cap',
    );
  });
  it('stops at the funder floor', async () => {
    const m = setup({ funder: 5_010_000n });
    expect(await m.svc.ensure(ADDR)).toBe('funder_floor');
    expect(m.chain.prepareFund).not.toHaveBeenCalled();
  });
  it('no double top-up while one is in flight', async () => {
    const m = setup({
      createErr: Object.assign(new Error('dup'), { code: 'P2002' }),
    });
    expect(await m.svc.ensure(ADDR)).toBe('in_flight');
    expect(m.chain.prepareFund).not.toHaveBeenCalled();
  });
  it('a failed send with a txId stays in flight (resolved via chain)', async () => {
    const m = setup({ sendErr: true });
    expect(await m.svc.ensure(ADDR)).toBe('failed');
    const statuses = m.prisma.chain_fee_topups.update.mock.calls.map(
      (c: any) => c[0].data.status,
    );
    expect(statuses).not.toContain('failed');
  });
  it('resolveStuck: confirmed -> sent, expired -> failed', async () => {
    const a = setup({
      stuck: [{ id: 'a', tx_id: 'T', last_valid: 10n }],
      txStatus: 'confirmed',
    });
    await a.svc.resolveStuck();
    expect(a.prisma.chain_fee_topups.update.mock.calls[0][0].data.status).toBe(
      'sent',
    );
    const b = setup({
      stuck: [{ id: 'b', tx_id: 'T', last_valid: 10n }],
      round: 11n,
    });
    await b.svc.resolveStuck();
    expect(b.prisma.chain_fee_topups.update.mock.calls[0][0].data.status).toBe(
      'failed',
    );
    const c = setup({
      stuck: [{ id: 'c', tx_id: 'T', last_valid: 10n }],
      round: 9n,
    });
    await c.svc.resolveStuck();
    expect(c.prisma.chain_fee_topups.update).not.toHaveBeenCalled();
  });
});
