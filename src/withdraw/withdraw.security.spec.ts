import { Test } from '@nestjs/testing';
import { WithdrawService, withdrawalDailyLimits } from './withdraw.service';
import { PrismaService } from '../database/prisma.service';
import { AuthService } from '../auth/auth.service';
import { SecurityService } from '../security/security.service';
import { PaystackService } from '../paystack/paystack.service';
import { CacheService } from '../common/cache/cache.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CurrencyConversionService } from '../currency/currency-conversion.service';
import { WebsocketGateway } from '../websocket/websocket.gateway';
import { NowpaymentsService } from '../nowpayments/nowpayments.service';

/**
 * In-memory Prisma double. $executeRaw applies the same guarded single-statement
 * semantics as the SQL in WithdrawService, and $transaction rolls back its own
 * writes on error, so interleaved async requests behave like concurrent DB txns.
 */
function createFakeDb(initialBalance: number) {
  const wallet = {
    id: 'w-user',
    user_id: 'user-1',
    balance: initialBalance,
    locked_balance: 0,
    is_frozen: false,
    is_active: true,
  };
  const adminWallet = { id: 'w-admin', balance: 0, locked_balance: 0 };
  const withdrawals: any[] = [];
  const transactions: any[] = [];
  const ledger: any[] = [];
  const tick = () => new Promise((r) => setImmediate(r));

  const makeClient = (undo: Array<() => void>) => {
    const client: any = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
        await tick();
        const sql = strings.join('?');
        if (sql.includes('locked_balance = COALESCE(locked_balance, 0) +')) {
          const [amount] = values;
          if (
            wallet.is_frozen ||
            wallet.balance - wallet.locked_balance < amount
          )
            return 0;
          wallet.locked_balance += amount;
          undo.push(() => (wallet.locked_balance -= amount));
          return 1;
        }
        if (sql.includes('SET balance = COALESCE(balance, 0) -')) {
          const [amount] = values;
          if (wallet.balance < amount) return 0;
          const prev = { ...wallet };
          wallet.balance -= amount;
          wallet.locked_balance = Math.max(wallet.locked_balance - amount, 0);
          undo.push(() => Object.assign(wallet, prev));
          return 1;
        }
        const [amount] = values;
        const prevLocked = wallet.locked_balance;
        wallet.locked_balance = Math.max(wallet.locked_balance - amount, 0);
        undo.push(() => (wallet.locked_balance = prevLocked));
        return 1;
      },
      wallets: {
        findFirst: async () => ({ ...wallet }),
        update: async ({ where, data }: any) => {
          if (where.id === adminWallet.id && data.balance?.increment)
            adminWallet.balance += data.balance.increment;
          return {};
        },
      },
      users: { findFirst: async () => ({ wallets: [adminWallet] }) },
      withdrawal: {
        create: async ({ data }: any) => {
          const row = {
            id: `wd-${withdrawals.length + 1}`,
            createdAt: new Date(),
            ...data,
          };
          withdrawals.push(row);
          undo.push(() => withdrawals.splice(withdrawals.indexOf(row), 1));
          return row;
        },
        findUnique: async ({ where }: any) =>
          withdrawals.find((w) => w.reference === where.reference) ?? null,
        findFirst: async ({ where }: any) =>
          withdrawals.find(
            (w) =>
              w.reference === where.reference ||
              where.OR?.some(
                (o: any) => o.id === w.id || o.reference === w.reference,
              ),
          ) ?? null,
        findMany: async () => [],
        updateMany: async ({ where, data }: any) => {
          await tick();
          const allowed: string[] =
            typeof where.status === 'string' ? [where.status] : where.status.in;
          const row = withdrawals.find(
            (w) =>
              w.reference === where.reference && allowed.includes(w.status),
          );
          if (!row) return { count: 0 };
          const prev = { ...row };
          Object.assign(row, data);
          undo.push(() => Object.assign(row, prev));
          return { count: 1 };
        },
        aggregate: async ({ where }: any) => {
          const rows = withdrawals.filter(
            (w) =>
              w.userId === where.userId &&
              w.status !== 'FAILED' &&
              (typeof where.method === 'string'
                ? w.method === where.method
                : where.method?.not
                  ? w.method !== where.method.not
                  : true),
          );
          return {
            _count: { _all: rows.length },
            _sum: { amount: rows.reduce((a, w) => a + w.amount, 0) },
          };
        },
      },
      transactions: {
        create: async ({ data }: any) => {
          const row = { id: `tx-${transactions.length + 1}`, ...data };
          transactions.push(row);
          undo.push(() => transactions.splice(transactions.indexOf(row), 1));
          return row;
        },
        findUnique: async ({ where }: any) =>
          transactions.find(
            (t) =>
              t.id === where.id ||
              t.transaction_reference === where.transaction_reference,
          ) ?? null,
        findFirst: async ({ where }: any) =>
          transactions.find(
            (t) => t.metadata?.nowpayments_payout_id === where.metadata?.equals,
          ) ?? null,
        findMany: async () =>
          transactions.filter(
            (t) =>
              ['pending', 'processing'].includes(t.status) &&
              t.metadata?.provider === 'nowpayments',
          ),
        update: async ({ where, data }: any) => {
          const row = transactions.find((t) => t.id === where.id);
          if (row) Object.assign(row, data);
          return row;
        },
      },
      ledger_entries: {
        create: async ({ data }: any) => (ledger.push(data), data),
        findFirst: async () => null,
      },
    };
    return client;
  };

  const root = makeClient([]);
  root.$transaction = async (cb: any) => {
    const undo: Array<() => void> = [];
    try {
      return await cb(makeClient(undo));
    } catch (e) {
      undo.reverse().forEach((f) => f());
      throw e;
    }
  };
  return {
    prisma: root,
    wallet,
    adminWallet,
    withdrawals,
    transactions,
    ledger,
  };
}

describe('WithdrawService security (race, idempotency, refunds)', () => {
  let service: WithdrawService;
  let db: ReturnType<typeof createFakeDb>;
  let nowpayments: any;
  let notifications: any;

  const fiat = (amount: number) =>
    ({
      method: 'MOBILE_MONEY',
      amount,
      pin: '1234',
      phoneNumber: '+254700000000',
    }) as any;
  const crypto = (amount: number) =>
    ({
      method: 'CRYPTO',
      amount,
      pin: '1234',
      cryptoAddress: 'bc1qvalidaddress',
      cryptoAsset: 'btc',
    }) as any;

  async function build(balance: number) {
    db = createFakeDb(balance);
    nowpayments = {
      getAvailableCurrencies: jest.fn().mockResolvedValue(['btc']),
      estimateAmount: jest.fn().mockResolvedValue(0.001),
      getPayoutMinimum: jest.fn().mockResolvedValue(0.0001),
      estimatePayoutFee: jest.fn().mockResolvedValue(0.00001),
      validatePayoutAddress: jest.fn().mockResolvedValue(true),
      createPayout: jest.fn().mockResolvedValue({
        id: 'np-batch-1',
        withdrawals: [{ status: 'creating' }],
      }),
      findPayoutByExternalId: jest.fn().mockResolvedValue(null),
      getPayout: jest.fn(),
      verifyPayout: jest.fn().mockResolvedValue({ status: 'processing' }),
      generatePayoutVerificationCode: jest.fn().mockReturnValue(null),
    };
    notifications = { sendNotification: jest.fn().mockResolvedValue(true) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        WithdrawService,
        { provide: PrismaService, useValue: db.prisma },
        {
          provide: AuthService,
          useValue: { verifyPin: jest.fn().mockResolvedValue(true) },
        },
        { provide: SecurityService, useValue: { verifyDevice: jest.fn() } },
        { provide: PaystackService, useValue: {} },
        {
          provide: CacheService,
          useValue: {
            cacheInvalidatePattern: jest.fn(),
            cacheDelete: jest.fn(),
          },
        },
        { provide: NotificationsService, useValue: notifications },
        {
          provide: CurrencyConversionService,
          useValue: {
            getCurrentRate: jest.fn().mockResolvedValue({
              farm_kes_rate: 1,
              farm_usd_rate: 0.01,
              usd_kes_rate: 130,
            }),
          },
        },
        {
          provide: WebsocketGateway,
          useValue: { emitBalanceUpdate: jest.fn() },
        },
        { provide: NowpaymentsService, useValue: nowpayments },
      ],
    }).compile();
    service = moduleRef.get(WithdrawService);
  }

  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };

  afterEach(() => {
    delete process.env.WITHDRAWAL_DAILY_MAX_COUNT;
    delete process.env.WITHDRAWAL_DAILY_MAX_AMOUNT;
    delete process.env.CRYPTO_WITHDRAWAL_DAILY_MAX_USD;
  });

  it('crypto uses its own USD daily cap and is exempt from the FARM cap', async () => {
    await build(100_000);
    jest.spyOn(service, 'submitNowpaymentsPayout').mockResolvedValue({} as any);
    jest
      .spyOn(service as any, 'processWithdrawal')
      .mockResolvedValue(undefined);
    process.env.WITHDRAWAL_DAILY_MAX_COUNT = '0';
    process.env.WITHDRAWAL_DAILY_MAX_AMOUNT = '3000'; // FARM, fiat only
    process.env.CRYPTO_WITHDRAWAL_DAILY_MAX_USD = '50'; // rate 0.01 => 5,000 FARM
    // 3,000 FARM = USD 30: above the FARM cap but crypto is exempt
    await service.createNowpaymentsCryptoWithdrawal('user-1', crypto(3_000));
    // another USD 30 would exceed USD 50
    await expect(
      service.createNowpaymentsCryptoWithdrawal('user-1', crypto(3_000)),
    ).rejects.toThrow(/Daily crypto withdrawal limit is USD 50/);
    expect(db.wallet.locked_balance).toBe(3_000);
    // fiat FARM cap ignores the crypto withdrawal
    await service.createWithdrawal('user-1', fiat(2_000));
    await expect(
      service.createWithdrawal('user-1', fiat(1_500)),
    ).rejects.toThrow(/Daily withdrawal amount limit/);
    expect(db.wallet.locked_balance).toBe(5_000);
  });

  it('crypto daily cap defaults to USD 100,000', async () => {
    delete process.env.CRYPTO_WITHDRAWAL_DAILY_MAX_USD;
    expect(withdrawalDailyLimits().cryptoMaxUsd).toBe(100_000);
  });

  it('concurrent automatic fiat withdrawals can never lock more than the balance', async () => {
    await build(10_000);
    process.env.WITHDRAWAL_DAILY_MAX_COUNT = '0';
    const payout = jest
      .spyOn(service as any, 'processWithdrawal')
      .mockResolvedValue(undefined);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        service.createWithdrawal('user-1', fiat(3_000)),
      ),
    );
    await flush();
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(db.wallet.locked_balance).toBe(9_000);
    expect(db.wallet.locked_balance).toBeLessThanOrEqual(db.wallet.balance);
    expect(db.withdrawals).toHaveLength(3);
    expect(payout).toHaveBeenCalledTimes(3); // only successfully locked requests auto-pay
  });

  it('concurrent automatic crypto withdrawals can never lock more than the balance', async () => {
    await build(1_000);
    process.env.WITHDRAWAL_DAILY_MAX_COUNT = '0';
    const submit = jest
      .spyOn(service, 'submitNowpaymentsPayout')
      .mockResolvedValue({} as any);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        service.createNowpaymentsCryptoWithdrawal('user-1', crypto(400)),
      ),
    );
    await flush();
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(db.wallet.locked_balance).toBe(800);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid crypto address before locking any funds', async () => {
    await build(1_000);
    nowpayments.validatePayoutAddress.mockResolvedValue(false);
    await expect(
      service.createNowpaymentsCryptoWithdrawal('user-1', crypto(400)),
    ).rejects.toThrow(/not a valid BTC address/);
    expect(db.wallet.locked_balance).toBe(0);
    expect(db.withdrawals).toHaveLength(0);
  });

  it('enforces daily count and amount limits and releases the lock when exceeded', async () => {
    await build(100_000);
    jest
      .spyOn(service as any, 'processWithdrawal')
      .mockResolvedValue(undefined);
    process.env.WITHDRAWAL_DAILY_MAX_COUNT = '2';
    await service.createWithdrawal('user-1', fiat(2_000));
    await service.createWithdrawal('user-1', fiat(2_000));
    await expect(
      service.createWithdrawal('user-1', fiat(2_000)),
    ).rejects.toThrow(/Daily withdrawal limit/);
    expect(db.wallet.locked_balance).toBe(4_000);

    process.env.WITHDRAWAL_DAILY_MAX_COUNT = '0';
    process.env.WITHDRAWAL_DAILY_MAX_AMOUNT = '5000';
    await expect(
      service.createWithdrawal('user-1', fiat(2_000)),
    ).rejects.toThrow(/Daily withdrawal amount limit/);
    expect(db.wallet.locked_balance).toBe(4_000);
  });

  it('business-API pre-authorised withdrawals skip only the PIN: same lock and daily limits', async () => {
    await build(10_000);
    jest
      .spyOn(service as any, 'processWithdrawal')
      .mockResolvedValue(undefined);
    process.env.WITHDRAWAL_DAILY_MAX_COUNT = '0';
    const noPin = { ...fiat(3_000), pin: undefined };
    await expect(service.createWithdrawal('user-1', noPin)).rejects.toThrow(
      /PIN is required/,
    );
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        service.createWithdrawal('user-1', noPin, {
          preAuthorized: 'business_api_key:k1',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(db.wallet.locked_balance).toBe(9_000);
    process.env.WITHDRAWAL_DAILY_MAX_AMOUNT = '9000';
    await expect(
      service.createWithdrawal(
        'user-1',
        { ...noPin, amount: 1_500 },
        {
          preAuthorized: 'k',
        },
      ),
    ).rejects.toThrow(/Daily withdrawal amount limit|Insufficient/);
  });

  it('auto-submits a crypto payout exactly once even if triggered concurrently', async () => {
    await build(1_000);
    const { reference } = await service.createNowpaymentsCryptoWithdrawal(
      'user-1',
      crypto(400),
    );
    await Promise.allSettled([
      service.submitNowpaymentsPayout(reference, 'system:auto'),
      service.submitNowpaymentsPayout(reference, 'admin-1'),
    ]);
    await flush();
    expect(nowpayments.createPayout).toHaveBeenCalledTimes(1);
    expect(nowpayments.createPayout.mock.calls[0][0].reference).toBe(reference);
    expect(db.transactions[0].metadata.nowpayments_payout_id).toBe(
      'np-batch-1',
    );
  });

  it('auto-verifies the payout when a NOWPayments 2FA secret is configured', async () => {
    await build(1_000);
    nowpayments.generatePayoutVerificationCode.mockReturnValue('123456');
    jest.spyOn(service, 'submitNowpaymentsPayout'); // real
    const { reference } = await service.createNowpaymentsCryptoWithdrawal(
      'user-1',
      crypto(400),
    );
    await flush();
    expect(nowpayments.verifyPayout).toHaveBeenCalledWith(
      'np-batch-1',
      '123456',
    );
    expect(db.transactions[0].metadata.nowpayments_payout_status).toBe(
      'processing',
    );
    expect(reference).toBeTruthy();
  });

  it('never re-submits a payout whose outcome is unknown; it looks it up instead', async () => {
    await build(1_000);
    nowpayments.createPayout.mockRejectedValueOnce(new Error('timeout'));
    jest
      .spyOn(service, 'submitNowpaymentsPayout')
      .mockResolvedValueOnce({} as any);
    const { reference } = await service.createNowpaymentsCryptoWithdrawal(
      'user-1',
      crypto(400),
    );
    await flush();
    await expect(
      service.submitNowpaymentsPayout(reference, 'system:auto'),
    ).rejects.toThrow(/not yet known/);
    expect(db.transactions[0].metadata.nowpayments_payout_status).toBe(
      'unknown',
    );

    // Retry with no payout found at NOWPayments: blocked, no second createPayout.
    await expect(
      service.approveNowpaymentsCryptoWithdrawal(reference, 'admin-1'),
    ).rejects.toThrow(/will not be re-submitted/);
    expect(nowpayments.createPayout).toHaveBeenCalledTimes(1);

    // Payout found by unique_external_id: recorded, still no second createPayout.
    nowpayments.findPayoutByExternalId.mockResolvedValue({
      id: 'np-found',
      status: 'processing',
    });
    await service.reconcileNowpaymentsPayouts();
    expect(nowpayments.createPayout).toHaveBeenCalledTimes(1);
    expect(db.transactions[0].metadata.nowpayments_payout_id).toBe('np-found');
    expect(db.wallet.locked_balance).toBe(400);
  });

  it('reconciler finalizes a payout from getPayout when the IPN was missed', async () => {
    await build(1_000);
    const { reference } = await service.createNowpaymentsCryptoWithdrawal(
      'user-1',
      crypto(400),
    );
    await flush();
    nowpayments.getPayout.mockResolvedValue({ status: 'FINISHED' });
    await service.reconcileNowpaymentsPayouts();
    expect(db.withdrawals.find((w) => w.reference === reference).status).toBe(
      'COMPLETED',
    );
    expect(db.wallet.balance).toBe(600);
    expect(db.wallet.locked_balance).toBe(0);
  });

  it('refunds a failed payout exactly once even with duplicate IPNs', async () => {
    await build(1_000);
    await service.createNowpaymentsCryptoWithdrawal('user-1', crypto(400));
    await flush();
    nowpayments.getPayout.mockResolvedValue({ status: 'failed' });
    await Promise.all([
      service.reconcileNowpaymentsPayoutWebhook({ id: 'np-batch-1' }),
      service.reconcileNowpaymentsPayoutWebhook({ id: 'np-batch-1' }),
    ]);
    expect(db.wallet.locked_balance).toBe(0);
    expect(db.wallet.balance).toBe(1_000);
    expect(notifications.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('does not refund a withdrawal that already completed', async () => {
    await build(10_000);
    jest
      .spyOn(service as any, 'processWithdrawal')
      .mockResolvedValue(undefined);
    const { reference } = await service.createWithdrawal('user-1', fiat(3_000));
    expect(await service.markAsSuccess(reference)).toBe(true);
    expect(await service.rejectWithdrawal(reference, 'late failure')).toBe(
      false,
    );
    expect(db.wallet.balance).toBe(7_000);
    expect(db.wallet.locked_balance).toBe(0);
  });

  it('guarded debit refuses to take the balance negative and rolls back', async () => {
    await build(10_000);
    jest
      .spyOn(service as any, 'processWithdrawal')
      .mockResolvedValue(undefined);
    const { reference } = await service.createWithdrawal('user-1', fiat(3_000));
    db.wallet.balance = 1_000; // inconsistent state
    await expect(service.markAsSuccess(reference)).rejects.toThrow(
      /insufficient to finalize/,
    );
    expect(db.withdrawals[0].status).toBe('PENDING');
    expect(db.wallet.balance).toBe(1_000);
  });

  it('legacy refund only closes non-NOWPayments crypto withdrawals', async () => {
    await build(1_000);
    db.withdrawals.push({
      id: 'legacy-1',
      reference: 'fc265c72-legacy',
      userId: 'user-1',
      method: 'CRYPTO',
      status: 'PROCESSING',
      amount: 300,
    });
    db.transactions.push({
      id: 'tx-legacy',
      transaction_reference: 'fc265c72-legacy',
      status: 'processing',
      metadata: { provider: 'ivorypay' },
    });
    db.wallet.locked_balance = 300;
    await expect(
      service.refundLegacyWithdrawal('fc265c72-legacy', 'super-1'),
    ).resolves.toBe(true);
    expect(db.wallet.locked_balance).toBe(0);
    await expect(
      service.refundLegacyWithdrawal('fc265c72-legacy', 'super-1'),
    ).rejects.toThrow(/already closed/);

    await service.createNowpaymentsCryptoWithdrawal('user-1', crypto(400));
    await expect(
      service.refundLegacyWithdrawal(db.withdrawals[1].reference, 'super-1'),
    ).rejects.toThrow(/Only legacy/);
  });
});
