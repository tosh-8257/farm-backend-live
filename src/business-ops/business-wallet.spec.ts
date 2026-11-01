import { settlementWalletFor, businessWalletEnabled } from './business-wallet';

const mk = (biz: any) => {
  const wallets: any[] = [
    { id: 'personal', user_id: 'owner', wallet_type: 'user', is_active: true },
  ];
  const db: any = {
    wallets: {
      findFirst: jest.fn(
        async ({ where }: any) =>
          wallets.find(
            (w) =>
              w.user_id === where.user_id &&
              (!where.wallet_type || w.wallet_type === where.wallet_type),
          ) ?? null,
      ),
      findUnique: jest.fn(
        async ({ where }: any) =>
          wallets.find((w) => w.id === where.id) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const w = { id: 'biz', ...data };
        wallets.push(w);
        return w;
      }),
      update: jest.fn(),
    },
    businesses: {
      findFirst: jest.fn(async () => biz),
      findUnique: jest.fn(async () => biz),
      updateMany: jest.fn(async () => {
        biz.wallet_id = 'biz';
        return { count: 1 };
      }),
    },
    merchants: { findUnique: jest.fn() },
  };
  return db;
};

describe('business wallet routing', () => {
  afterEach(() => delete process.env.BUSINESS_WALLET_ENABLED);

  it('is off by default and keeps the personal wallet', async () => {
    expect(businessWalletEnabled()).toBe(false);
    const db = mk({ id: 'b', status: 'approved', wallet_id: null });
    const w = await settlementWalletFor(db, { ownerUserId: 'owner' });
    expect(w.id).toBe('personal');
    expect(db.wallets.create).not.toHaveBeenCalled();
  });

  it('creates and uses a separate merchant wallet (no user_id) when on', async () => {
    process.env.BUSINESS_WALLET_ENABLED = 'true';
    const db = mk({
      id: 'b',
      status: 'approved',
      wallet_id: null,
      owner_user_id: 'owner',
    });
    const w = await settlementWalletFor(db, { ownerUserId: 'owner' });
    expect(w.id).toBe('biz');
    expect(w.wallet_type).toBe('merchant');
    expect(w.user_id).toBeNull();
    const again = await settlementWalletFor(db, { ownerUserId: 'owner' });
    expect(again.id).toBe('biz');
    expect(db.wallets.create).toHaveBeenCalledTimes(1);
  });

  it('falls back to personal for an unapproved business', async () => {
    process.env.BUSINESS_WALLET_ENABLED = 'true';
    const db = mk({
      id: 'b',
      status: 'submitted',
      wallet_id: null,
      owner_user_id: 'owner',
    });
    expect((await settlementWalletFor(db, { ownerUserId: 'owner' })).id).toBe(
      'personal',
    );
  });
});
