import {
  DEFAULT_REFRESH_TTL_MS,
  longLivedSessionsEnabled,
  parseDurationMs,
} from './session-policy';

describe('session policy', () => {
  it('is off unless LONG_LIVED_SESSIONS_ENABLED is exactly true', () => {
    expect(longLivedSessionsEnabled({})).toBe(false);
    expect(
      longLivedSessionsEnabled({ LONG_LIVED_SESSIONS_ENABLED: 'false' }),
    ).toBe(false);
    expect(
      longLivedSessionsEnabled({ LONG_LIVED_SESSIONS_ENABLED: 'true' }),
    ).toBe(true);
  });

  it('parses duration units and rejects junk', () => {
    expect(parseDurationMs('90d', 1)).toBe(90 * 86_400_000);
    expect(parseDurationMs('15m', 1)).toBe(15 * 60_000);
    expect(parseDurationMs('12h', 1)).toBe(12 * 3_600_000);
    expect(parseDurationMs('30s', 1)).toBe(30_000);
    expect(parseDurationMs('forever', 5)).toBe(5);
    expect(parseDurationMs('', DEFAULT_REFRESH_TTL_MS)).toBe(
      DEFAULT_REFRESH_TTL_MS,
    );
  });
});
