export type OutboxRow = {
  status: string;
  last_error?: string | null;
};

/**
 * A blocked row is waiting on reconciliation itself when the sender's
 * on-chain FARM balance was short. Those must not stop the top-up.
 * pending, submitting, and sending are still in flight. Any other
 * non-final status (including failed, and blocked for another reason)
 * still refuses the execute.
 */
export function isInsufficientFarmBlock(row: OutboxRow): boolean {
  if (row.status !== 'blocked') return false;
  const error = (row.last_error ?? '').toLowerCase();
  return (
    error.includes('not enough farm') || error.includes('insufficient farm')
  );
}

export function outboxBlocksReconcile(
  rows: OutboxRow[],
): { ok: true } | { ok: false; reason: string } {
  const blocking = rows.filter((row) => !isInsufficientFarmBlock(row));
  if (!blocking.length) return { ok: true };
  const inflight = blocking.filter((row) =>
    ['pending', 'submitting', 'sending'].includes(row.status),
  );
  if (inflight.length) {
    const noun =
      inflight.length === 1
        ? '1 on-chain transfer is still in flight'
        : `${inflight.length} on-chain transfers are still in flight`;
    return {
      ok: false,
      reason: `${noun} (pending or submitting); run again when the outbox is drained`,
    };
  }
  const noun =
    blocking.length === 1
      ? '1 on-chain transfer is still in flight'
      : `${blocking.length} on-chain transfers are still in flight`;
  return {
    ok: false,
    reason: `${noun}; run again when the outbox is drained`,
  };
}
