import {
  CREATED_RETRY_DELAY_MS,
  PROVISION_RETRY_DELAYS_MS,
  provisionRetryDelayMs,
  provisionRetryDue,
} from './wallet-provision-policy';

describe('wallet provision retry backoff', () => {
  it('waits briefly for a wallet that has never failed, then backs off', () => {
    expect(provisionRetryDelayMs(0)).toBe(CREATED_RETRY_DELAY_MS);
    expect(provisionRetryDelayMs(1)).toBe(PROVISION_RETRY_DELAYS_MS[0]);
    expect(provisionRetryDelayMs(2)).toBe(PROVISION_RETRY_DELAYS_MS[1]);
    expect(provisionRetryDelayMs(99)).toBe(
      PROVISION_RETRY_DELAYS_MS[PROVISION_RETRY_DELAYS_MS.length - 1],
    );
  });

  it('retries only created and failed rows whose backoff has elapsed', () => {
    const now = Date.parse('2026-11-10T00:00:00Z');
    const updatedAt = new Date(now - PROVISION_RETRY_DELAYS_MS[0]);
    expect(
      provisionRetryDue({
        status: 'failed',
        attempts: 1,
        updatedAt,
        now,
      }),
    ).toBe(true);
    expect(
      provisionRetryDue({
        status: 'failed',
        attempts: 1,
        updatedAt: new Date(now - 1_000),
        now,
      }),
    ).toBe(false);
    expect(
      provisionRetryDue({
        status: 'ready',
        attempts: 0,
        updatedAt: new Date(0),
        now,
      }),
    ).toBe(false);
    expect(
      provisionRetryDue({
        status: 'created',
        attempts: 0,
        updatedAt: new Date(now - CREATED_RETRY_DELAY_MS),
        now,
      }),
    ).toBe(true);
  });
});
