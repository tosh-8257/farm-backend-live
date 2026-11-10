/** After a failure: 1m, 5m, 15m, 1h, 6h, then daily. */
export const PROVISION_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
];

/** A row still `created` has not failed yet; give the first attempt a moment. */
export const CREATED_RETRY_DELAY_MS = 30_000;

/** Provisioning left in progress this long is treated as failed and retried. */
export const STUCK_PROVISIONING_MS = 10 * 60_000;

export const PROVISION_RETRY_BATCH = 20;

export function provisionRetryDelayMs(attempts: number): number {
  if (!Number.isFinite(attempts) || attempts <= 0)
    return CREATED_RETRY_DELAY_MS;
  const index = Math.min(
    Math.floor(attempts) - 1,
    PROVISION_RETRY_DELAYS_MS.length - 1,
  );
  return PROVISION_RETRY_DELAYS_MS[index];
}

export function provisionRetryDue(input: {
  status: string;
  attempts: number;
  updatedAt: Date;
  now: number;
}): boolean {
  if (input.status !== 'created' && input.status !== 'failed') return false;
  return (
    input.now - input.updatedAt.getTime() >=
    provisionRetryDelayMs(input.attempts)
  );
}
