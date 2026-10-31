import { CurrencyConversionService } from './currency-conversion.service';
import { LiveFxService } from './live-fx.service';

function prismaMock(rows: any[]) {
  const state = { rows: [...rows] };
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ exists: 'currency_rates' }]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    currency_rates: {
      findFirst: jest.fn(
        async () =>
          state.rows
            .filter((r) => r.is_active)
            .sort((a, b) => +b.effective_at - +a.effective_at)[0] ?? null,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        state.rows.forEach((r) => {
          if (
            r.is_active &&
            (where.is_override === undefined ||
              r.is_override === where.is_override)
          ) {
            Object.assign(r, data);
          }
        });
        return { count: 1 };
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `r${state.rows.length}`, ...data };
        state.rows.push(row);
        return row;
      }),
    },
  };
  return { prisma, state };
}

describe('CurrencyConversionService live USD/KES', () => {
  const env = process.env.FX_LIVE_RATE_ENABLED;
  afterEach(() => {
    process.env.FX_LIVE_RATE_ENABLED = env;
  });

  it('uses the stored manual rate when live FX is disabled', async () => {
    delete process.env.FX_LIVE_RATE_ENABLED;
    const { prisma } = prismaMock([
      {
        id: 'a',
        usd_kes_rate: 131,
        farm_kes_rate: 1,
        is_active: true,
        effective_at: new Date(),
      },
    ]);
    const live = { fetchUsdKes: jest.fn() } as any;
    const svc = new CurrencyConversionService(prisma, live);
    const r = await svc.getCurrentRate();
    expect(r.usd_kes_rate).toBe(131);
    expect(r.live_enabled).toBe(false);
    expect(live.fetchUsdKes).not.toHaveBeenCalled();
  });

  it('stores a fresh live rate when enabled and no override is set', async () => {
    process.env.FX_LIVE_RATE_ENABLED = 'true';
    const { prisma, state } = prismaMock([
      {
        id: 'a',
        usd_kes_rate: 150,
        farm_kes_rate: 1,
        is_active: true,
        effective_at: new Date(0),
      },
    ]);
    const live = {
      fetchUsdKes: jest.fn().mockResolvedValue({
        rate: 129.25,
        fetched_at: new Date().toISOString(),
      }),
    } as any;
    const svc = new CurrencyConversionService(prisma, live);
    const r = await svc.getCurrentRate();
    expect(r.usd_kes_rate).toBe(129.25);
    expect(r.source).toBe('live');
    expect(state.rows.filter((x) => x.is_active)).toHaveLength(1);
  });

  it('keeps a manual override and does not fetch', async () => {
    process.env.FX_LIVE_RATE_ENABLED = 'true';
    const { prisma } = prismaMock([
      {
        id: 'a',
        usd_kes_rate: 140,
        farm_kes_rate: 1,
        is_active: true,
        is_override: true,
        source: 'manual',
        effective_at: new Date(0),
      },
    ]);
    const live = { fetchUsdKes: jest.fn() } as any;
    const svc = new CurrencyConversionService(prisma, live);
    const r = await svc.getCurrentRate();
    expect(r.usd_kes_rate).toBe(140);
    expect(r.is_override).toBe(true);
    expect(live.fetchUsdKes).not.toHaveBeenCalled();
  });

  it('falls back to the last rate (stale) when the feed fails', async () => {
    process.env.FX_LIVE_RATE_ENABLED = 'true';
    const { prisma } = prismaMock([
      {
        id: 'a',
        usd_kes_rate: 130,
        farm_kes_rate: 1,
        is_active: true,
        source: 'live',
        effective_at: new Date(0),
      },
    ]);
    const live = { fetchUsdKes: jest.fn().mockResolvedValue(null) } as any;
    const r = await new CurrencyConversionService(
      prisma,
      live,
    ).getCurrentRate();
    expect(r.usd_kes_rate).toBe(130);
    expect(r.stale).toBe(true);
  });

  it('clearOverride returns to the live rate', async () => {
    process.env.FX_LIVE_RATE_ENABLED = 'true';
    const { prisma } = prismaMock([
      {
        id: 'a',
        usd_kes_rate: 140,
        farm_kes_rate: 1,
        is_active: true,
        is_override: true,
        effective_at: new Date(),
      },
    ]);
    const live = {
      fetchUsdKes: jest
        .fn()
        .mockResolvedValue({ rate: 129, fetched_at: new Date().toISOString() }),
    } as any;
    const r = await new CurrencyConversionService(prisma, live).clearOverride();
    expect(r.usd_kes_rate).toBe(129);
    expect(r.is_override).toBe(false);
  });
});

describe('LiveFxService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('parses KES from the feed', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        rates: { KES: 129.4 },
        time_last_update_utc: 'Fri, 30 Oct 2026 00:02:31 +0000',
      }),
    }) as any;
    const q = await new LiveFxService().fetchUsdKes();
    expect(q?.rate).toBe(129.4);
    expect(q?.provider_updated_at).toBe('2026-10-30T00:02:31.000Z');
  });

  it('rejects out-of-range values', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ rates: { KES: 1 } }),
    }) as any;
    const svc = new LiveFxService();
    expect(await svc.fetchUsdKes()).toBeNull();
    expect(svc.lastError).toMatch(/out of range/);
  });
});
