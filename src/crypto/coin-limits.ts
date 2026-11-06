import { BadRequestException } from '@nestjs/common';

export type CoinLimit = { min?: number; max?: number };

/**
 * Per-coin caps from CRYPTO_COIN_LIMITS, a JSON object keyed by currency code:
 * `{ "btc": { "min": 0.0001, "max": 1 }, "usdttrc20": { "max": 50000 } }`.
 * Amounts are in that coin's own units. Invalid JSON or entries are ignored.
 */
export function configuredCoinLimits(
  env: Record<string, string | undefined> = process.env,
): Record<string, CoinLimit> {
  const raw = env.CRYPTO_COIN_LIMITS;
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, CoinLimit> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const code = key.trim().toLowerCase();
    if (!/^[a-z0-9]{2,20}$/.test(code)) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const min = Number((value as { min?: unknown }).min);
    const max = Number((value as { max?: unknown }).max);
    const row: CoinLimit = {};
    if (Number.isFinite(min) && min > 0) row.min = min;
    if (Number.isFinite(max) && max > 0) row.max = max;
    if (row.min != null || row.max != null) out[code] = row;
  }
  return out;
}

export function coinLimitFor(
  currency: string,
  env: Record<string, string | undefined> = process.env,
): CoinLimit {
  return configuredCoinLimits(env)[currency.trim().toLowerCase()] ?? {};
}

/**
 * Effective minimum is the greater of the provider minimum (NOWPayments
 * min-amount) and the configured per-coin minimum. Maximum is the configured
 * per-coin maximum when set.
 */
export function resolveCoinBounds(currency: string, providerMin?: number) {
  const cfg = coinLimitFor(currency);
  const provider =
    providerMin != null && Number.isFinite(providerMin) && providerMin > 0
      ? providerMin
      : 0;
  const min = Math.max(cfg.min ?? 0, provider);
  return {
    currency: currency.trim().toLowerCase(),
    min_amount: min > 0 ? min : null,
    min_source:
      provider > 0 && provider >= (cfg.min ?? 0)
        ? 'provider'
        : cfg.min
          ? 'config'
          : null,
    max_amount: cfg.max ?? null,
    max_source: cfg.max != null ? 'config' : null,
  };
}

export function assertCoinAmount(
  currency: string,
  amount: number,
  providerMin?: number,
) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new BadRequestException('Enter a valid cryptocurrency amount');
  }
  const bounds = resolveCoinBounds(currency, providerMin);
  const label = bounds.currency.toUpperCase();
  if (bounds.min_amount != null && amount < bounds.min_amount) {
    throw new BadRequestException(
      `Minimum for ${label} is ${bounds.min_amount} ${label}`,
    );
  }
  if (bounds.max_amount != null && amount > bounds.max_amount) {
    throw new BadRequestException(
      `Maximum for ${label} is ${bounds.max_amount} ${label}`,
    );
  }
  return bounds;
}
