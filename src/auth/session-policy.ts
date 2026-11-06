/** Long-lived refresh tokens and biometric re-auth. Off unless explicitly enabled. */
export function longLivedSessionsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.LONG_LIVED_SESSIONS_ENABLED === 'true';
}

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parses `90d` / `15m` / `12h` / `30s`. Invalid values use the fallback. */
export function parseDurationMs(raw: string | undefined, fallbackMs: number) {
  const match = /^(\d{1,6})([smhd])$/.exec((raw ?? '').trim());
  if (!match) return fallbackMs;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  return n * UNIT_MS[match[2]];
}

export const DEFAULT_REFRESH_TTL = '90d';
export const DEFAULT_REFRESH_TTL_MS = 90 * 86_400_000;
