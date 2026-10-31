import { HttpException } from '@nestjs/common';
import { parseUsage } from './ai-provider';
import { MkulimaBillingService } from './mkulima-billing.service';

const TABLE = JSON.stringify({
  models: { 'grok-4.3': { input: 2, cached_input: 0.5, output: 10 } },
  stt: { 'grok-voice-transcribe-2.0': { per_minute: 0.006 } },
});

function make(
  env: Record<string, string | undefined>,
  wallet: any = { id: 'w1', balance: 100, is_frozen: false },
) {
  const created: any = { tx: [], ledger: [], usage: [] };
  const tx: any = {
    wallets: {
      findFirst: jest.fn().mockResolvedValue(wallet),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    users: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ wallets: [{ id: 'pw', balance: 0 }] }),
    },
    transactions: {
      upsert: jest.fn().mockImplementation(({ where, create, update }) => {
        const ex = created.tx.find(
          (t: any) => t.transaction_reference === where.transaction_reference,
        );
        if (!ex) {
          created.tx.push({ ...create });
          return { id: 't1', ...create };
        }
        ex.amount += update.amount.increment;
        ex.fee += update.fee.increment;
        ex.net_amount += update.net_amount.increment;
        return { id: 't1', ...ex };
      }),
      findMany: jest
        .fn()
        .mockImplementation(() =>
          created.tx.map((t: any, i: number) => ({ id: `t${i}`, ...t })),
        ),
      updateMany: jest
        .fn()
        .mockImplementation(({ where }) => ({ count: where.id.in.length })),
    },
    ledger_entries: {
      create: jest
        .fn()
        .mockImplementation(({ data }) => created.ledger.push(data)),
    },
    mkulima_usage: {
      create: jest.fn().mockImplementation(({ data }) => {
        created.usage.push(data);
        return data;
      }),
      findMany: jest.fn().mockImplementation(() => created.usage),
    },
  };
  const prisma: any = {
    wallets: tx.wallets,
    transactions: tx.transactions,
    mkulima_usage: tx.mkulima_usage,
    $transaction: (fn: any) => fn(tx),
  };
  const config: any = { get: (k: string) => env[k] };
  const fx: any = {
    getCurrentRate: jest
      .fn()
      .mockResolvedValue({ usd_kes_rate: 130, farm_kes_rate: 1 }),
  };
  return { svc: new MkulimaBillingService(prisma, config, fx), created, tx };
}

const usage = (o: Partial<any> = {}) => ({
  model: 'grok-4.3',
  prompt_tokens: 1_000_000,
  cached_tokens: 0,
  output_tokens: 100_000,
  cost_usd: null,
  ...o,
});

describe('parseUsage', () => {
  it('reads tokens, cached tokens and provider cost ticks', () => {
    const u = parseUsage(
      {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 30 },
        cost_in_usd_ticks: 12_345_000,
      },
      'grok-4.3',
    )!;
    expect(u.output_tokens).toBe(50); // reasoning billed separately
    expect(u.cached_tokens).toBe(40);
    expect(u.cost_usd).toBeCloseTo(0.0012345, 10);
  });
  it('does not double count reasoning already inside completion_tokens', () => {
    const u = parseUsage(
      {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        completion_tokens_details: { reasoning_tokens: 30 },
      },
      'm',
    )!;
    expect(u.output_tokens).toBe(50);
    expect(u.cost_usd).toBeNull();
  });
  it('returns null without usage', () =>
    expect(parseUsage(undefined, 'm')).toBeNull());
});

describe('MkulimaBillingService', () => {
  it('is off by default and charges nothing', async () => {
    const { svc, created } = make({ MKULIMA_PRICE_TABLE: TABLE });
    await expect(svc.assertCanUse('u', 'grok-4.3')).resolves.toBeUndefined();
    expect(
      await svc.charge({
        userId: 'u',
        kind: 'chat',
        model: 'grok-4.3',
        usages: [usage()],
      }),
    ).toBeNull();
    expect(created.tx).toHaveLength(0);
  });

  it('prices chat from the table: (1M-cached)*in + cached*cached_in + out*out', () => {
    const { svc } = make({ MKULIMA_PRICE_TABLE: TABLE });
    const c = svc.chatCostUsd([usage({ cached_tokens: 200_000 })]);
    expect(c.source).toBe('price_table');
    expect(c.cost_usd).toBeCloseTo(0.8 * 2 + 0.2 * 0.5 + 0.1 * 10, 10); // 2.7
  });

  it('prefers provider-reported cost when every call has it', () => {
    const { svc } = make({});
    const c = svc.chatCostUsd([
      usage({ cost_usd: 0.01 }),
      usage({ cost_usd: 0.02 }),
    ]);
    expect(c).toEqual({ cost_usd: 0.03, source: 'provider' });
  });

  it('never invents a price', () => {
    const { svc } = make({});
    expect(() => svc.chatCostUsd([usage()])).toThrow(/No price/);
    expect(() => svc.sttCostUsd('x', 10)).toThrow(/No price/);
  });

  it('charges cost x 1.25 from the wallet and books the 25% as fee on mkulima_usage', async () => {
    const { svc, created } = make({
      MKULIMA_BILLING_ENABLED: 'true',
      MKULIMA_PRICE_TABLE: TABLE,
    });
    // 1000 prompt + 100 output tokens = 0.002 + 0.001 = 0.003 USD = 0.39 FARM
    await svc.charge({
      userId: 'u',
      kind: 'chat',
      model: 'grok-4.3',
      usages: [usage({ prompt_tokens: 1000, output_tokens: 100 })],
    });
    const t = created.tx[0];
    expect(t.transaction_type).toBe('mkulima_usage');
    expect(t.description).toBe('Mkulima AI');
    expect(t.status).toBe('pending');
    expect(t.transaction_reference).toMatch(/^MKAI-\d{8}-u$/);
    expect(t.amount).toBeCloseTo(0.4875, 8);
    expect(t.fee).toBeCloseTo(0.0975, 8);
    expect(t.receiver_wallet_id).toBe('pw');
    expect(created.ledger.map((l: any) => l.entry_type)).toEqual([
      'debit',
      'credit',
    ]);
    const u = created.usage[0];
    expect(u.status).toBe('charged');
    expect(u.cost_farm).toBeCloseTo(0.39, 8);
    expect(u.usd_kes_rate).toBe(130);
  });

  it('prices voice per minute of audio', async () => {
    const { svc, created } = make({
      MKULIMA_BILLING_ENABLED: 'true',
      MKULIMA_PRICE_TABLE: TABLE,
    });
    await svc.charge({
      userId: 'u',
      kind: 'voice',
      model: 'grok-voice-transcribe-2.0',
      audioSeconds: 30,
    });
    // 0.5 min * 0.006 = 0.003 USD -> 0.39 FARM -> 0.4875 charged
    expect(created.tx[0].amount).toBeCloseTo(0.4875, 8);
    expect(created.usage[0].audio_seconds).toBe(30);
  });

  it('never overdraws: takes what is left and records the shortfall', async () => {
    const { svc, created } = make(
      { MKULIMA_BILLING_ENABLED: 'true', MKULIMA_PRICE_TABLE: TABLE },
      { id: 'w1', balance: 0.1, is_frozen: false },
    );
    await svc.charge({
      userId: 'u',
      kind: 'chat',
      model: 'grok-4.3',
      usages: [usage({ prompt_tokens: 1000, output_tokens: 100 })],
    });
    expect(created.tx[0].amount).toBeCloseTo(0.1, 8);
    expect(created.tx[0].fee).toBeCloseTo(0.0975, 8);
    expect(created.usage[0].status).toBe('partial');
    expect(created.usage[0].shortfall_farm).toBeCloseTo(0.3875, 8);
  });

  it('blocks with a plain 402 top-up message when the balance is too low', async () => {
    const { svc } = make(
      { MKULIMA_BILLING_ENABLED: 'true', MKULIMA_PRICE_TABLE: TABLE },
      { id: 'w1', balance: 0.5, is_frozen: false },
    );
    const err = await svc.assertCanUse('u', 'grok-4.3').catch((e) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(402);
    expect(JSON.stringify((err as HttpException).getResponse())).toMatch(
      /Top up your wallet/,
    );
  });

  it('fails closed (503) when billing is on but the model has no price', async () => {
    const { svc } = make({ MKULIMA_BILLING_ENABLED: 'true' });
    const err = await svc.assertCanUse('u', 'grok-4.3').catch((e) => e);
    expect((err as HttpException).getStatus()).toBe(503);
  });

  it('respects a custom margin', async () => {
    const { svc } = make({ MKULIMA_MARGIN_PCT: '40' });
    const q = await svc.quote(0.01);
    expect(q.cost_farm).toBeCloseTo(1.3, 8);
    expect(q.margin_farm).toBeCloseTo(0.52, 8);
  });

  it('accrues every use of the day onto ONE Mkulima AI transaction, debiting per use', async () => {
    const { svc, created, tx } = make({
      MKULIMA_BILLING_ENABLED: 'true',
      MKULIMA_PRICE_TABLE: TABLE,
    });
    const u = [usage({ prompt_tokens: 1000, output_tokens: 100 })];
    await svc.charge({
      userId: 'u',
      kind: 'chat',
      model: 'grok-4.3',
      usages: u,
    });
    await svc.charge({
      userId: 'u',
      kind: 'chat',
      model: 'grok-4.3',
      usages: u,
    });
    expect(created.tx).toHaveLength(1);
    expect(created.tx[0].amount).toBeCloseTo(0.975, 8);
    expect(created.tx[0].fee).toBeCloseTo(0.195, 8);
    expect(tx.wallets.updateMany).toHaveBeenCalledTimes(2);
    expect(created.usage).toHaveLength(2);
  });

  it('uses the Nairobi day for the daily reference', () => {
    const { svc } = make({});
    // 22:30 UTC on Oct 31 is already Nov 1 in Nairobi
    expect(svc.dayKey(new Date('2026-10-31T22:30:00Z'))).toBe('20261101');
    expect(svc.dailyRef('ab-cd', '20261101')).toBe('MKAI-20261101-abcd');
  });

  it('settles past days only', async () => {
    const { svc, created, tx } = make({ MKULIMA_BILLING_ENABLED: 'true' });
    created.tx.push(
      { transaction_reference: 'MKAI-20261030-u' },
      { transaction_reference: 'MKAI-20261031-u' },
    );
    const r = await svc.settleDaily(new Date('2026-10-31T10:00:00Z'));
    expect(r.settled).toBe(1);
    expect(tx.transactions.updateMany.mock.calls[0][0].where.id.in).toEqual([
      't0',
    ]);
  });

  it('blocks at zero balance even when the floor is 0', async () => {
    const { svc } = make(
      {
        MKULIMA_BILLING_ENABLED: 'true',
        MKULIMA_PRICE_TABLE: TABLE,
        MKULIMA_MIN_BALANCE_FARM: '0',
      },
      { id: 'w1', balance: 0, is_frozen: false },
    );
    const err = await svc.assertCanUse('u', 'grok-4.3').catch((e) => e);
    expect((err as HttpException).getStatus()).toBe(402);
  });

  it('requires enough for the costliest recent use, not just the floor', async () => {
    const { svc, created } = make(
      { MKULIMA_BILLING_ENABLED: 'true', MKULIMA_PRICE_TABLE: TABLE },
      { id: 'w1', balance: 2, is_frozen: false },
    );
    created.usage.push({ charge_farm: 3 });
    const err = await svc.assertCanUse('u', 'grok-4.3').catch((e) => e);
    expect((err as HttpException).getStatus()).toBe(402);
  });
});
