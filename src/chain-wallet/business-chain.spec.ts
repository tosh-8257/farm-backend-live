import { randomBytes } from 'crypto';
import {
  createBusinessChainAccount,
  BusinessChainService,
} from './business-chain.service';
import { openSecret, sealSecret } from './key-vault';
import { signerFromSeed } from './signer';

const KEY = randomBytes(32).toString('base64');

describe('business chain accounts', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.WALLET_KEY_ENCRYPTION_KEY = KEY;
    process.env.ALGORAND_NETWORK = 'testnet';
  });
  afterEach(() => (process.env = { ...env }));

  it('creates a sealed account bound to its address, secret never stored in clear', async () => {
    const rows: any[] = [];
    const prisma: any = {
      business_chain_wallets: {
        findUnique: jest.fn(async () => rows[0] ?? null),
        create: jest.fn(async ({ data }: any) => (rows.push(data), data)),
      },
    };
    const r = await createBusinessChainAccount(prisma, 'b1', 'w1');
    expect(r.address).toMatch(/^[A-Z2-7]{58}$/);
    expect(r.wallet_id).toBe('w1');
    expect(JSON.stringify(r)).not.toMatch(/seed|mnemonic/i);
    expect(openSecret(r, r.address).length).toBe(32);
    const again = await createBusinessChainAccount(prisma, 'b1', 'w1');
    expect(again).toBe(rows[0]);
    expect(prisma.business_chain_wallets.create).toHaveBeenCalledTimes(1);
  });

  it('provision funds once and opts in to FARM, respecting the daily cap', async () => {
    process.env.FARM_ASA_ID = '123';
    process.env.BUSINESS_CHAIN_PROVISION_DAILY_MAX = '0';
    const row: any = { id: 'x', status: 'created' };
    const prisma: any = {
      business_chain_wallets: {
        updateMany: jest.fn(async () => ({ count: 1 })),
        findUnique: jest.fn(async () => row),
        count: jest.fn(async () => 0),
        update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
      },
    };
    const chain: any = { fund: jest.fn(), optIn: jest.fn() };
    const svc = new BusinessChainService(prisma, chain);
    await svc.provision('x');
    expect(chain.fund).not.toHaveBeenCalled();
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/cap/);
  });

  it('is off unless BUSINESS_WALLET_ENABLED', async () => {
    const svc = new BusinessChainService({} as any, {} as any);
    expect(svc.enabled()).toBe(false);
    await expect(svc.tick()).resolves.toBeUndefined();
  });
  describe('USDC opt-in', () => {
    function setup(
      row: any,
      info = { amount: 400_000n, minBalance: 200_000n },
    ) {
      process.env.FARM_ASA_ID = '123';
      process.env.USDC_ASA_ID = '10458941';
      process.env.BUSINESS_CHAIN_PROVISION_DAILY_MAX = '25';
      const seed = new Uint8Array(32).fill(7);
      const addr = signerFromSeed(seed, 'ed25519').address;
      const sealed = sealSecret(seed, addr);
      Object.assign(row, {
        address: addr,
        key_scheme: 'ed25519',
        ...sealed,
      });
      const prisma: any = {
        business_chain_wallets: {
          updateMany: jest.fn(async () => ({ count: 1 })),
          findUnique: jest.fn(async () => ({ ...row })),
          count: jest.fn(async () => 0),
          update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
        },
      };
      const chain: any = {
        fund: jest.fn(async () => 'TOPUP'),
        optIn: jest.fn(async (_a: string, _s: any, asa: bigint) => `OPT${asa}`),
        isOptedIn: jest.fn(async () => false),
        algoInfo: jest.fn(async () => info),
      };
      return { svc: new BusinessChainService(prisma, chain), chain, prisma };
    }
    afterEach(() => delete process.env.USDC_ASA_ID);

    it('new account: funds, opts in to FARM and USDC, ready', async () => {
      const row: any = { id: 'x', status: 'created' };
      const { svc, chain } = setup(row, {
        amount: 310_000n,
        minBalance: 200_000n,
      });
      await svc.provision('x');
      expect(chain.optIn.mock.calls.map((c: any) => c[2])).toEqual([
        123n,
        10458941n,
      ]);
      expect(row).toMatchObject({
        status: 'ready',
        usdc_opt_in_tx: 'OPT10458941',
      });
    });

    it('catch-up: tops up only the shortfall within the cap', async () => {
      const row: any = {
        id: 'x',
        status: 'ready',
        funded_tx_id: 'F',
        farm_opt_in_tx: 'O',
      };
      const { svc, chain } = setup(row, {
        amount: 250_000n,
        minBalance: 200_000n,
      });
      await svc.provision('x');
      expect(chain.fund).toHaveBeenCalledWith(row.address, 52_000n);
      expect(chain.optIn).toHaveBeenCalledTimes(1);
      expect(row.status).toBe('ready');
    });

    it('catch-up failure keeps the account ready and records the error', async () => {
      process.env.BUSINESS_CHAIN_USDC_TOPUP_MAX_MICROALGOS = '1000';
      const row: any = {
        id: 'x',
        status: 'ready',
        funded_tx_id: 'F',
        farm_opt_in_tx: 'O',
      };
      const { svc, chain } = setup(row, { amount: 0n, minBalance: 200_000n });
      await svc.provision('x');
      delete process.env.BUSINESS_CHAIN_USDC_TOPUP_MAX_MICROALGOS;
      expect(chain.fund).not.toHaveBeenCalled();
      expect(row).toMatchObject({
        status: 'ready',
        error: expect.stringMatching(/cap/),
      });
      expect(row.usdc_opt_in_tx).toBeUndefined();
    });

    it('already opted in on chain: no new transaction', async () => {
      const row: any = {
        id: 'x',
        status: 'ready',
        funded_tx_id: 'F',
        farm_opt_in_tx: 'O',
      };
      const { svc, chain } = setup(row);
      chain.isOptedIn.mockResolvedValue(true);
      await svc.provision('x');
      expect(chain.optIn).not.toHaveBeenCalled();
      expect(row.usdc_opt_in_tx).toBe('already-opted-in');
    });
  });
});
