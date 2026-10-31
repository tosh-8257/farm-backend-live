import { randomBytes } from 'crypto';
import {
  createBusinessChainAccount,
  BusinessChainService,
} from './business-chain.service';
import { openSecret } from './key-vault';

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
});
