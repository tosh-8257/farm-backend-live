export type ReconcileMode = 'dry' | 'send';

export type WalletDelta = {
  key: string;
  address: string;
  deltaFarm: number;
};

export type ReconcileCaps = {
  maxPerWallet: number;
  maxTotal: number;
};

export function reconcileCaps(
  env: Record<string, string | undefined> = process.env,
): ReconcileCaps {
  const n = (name: string, fallback: number) => {
    const v = Number(env[name]);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  return {
    maxPerWallet: n('RECONCILE_MAX_PER_WALLET_FARM', 100_000),
    maxTotal: n('RECONCILE_MAX_TOTAL_FARM', 1_000_000),
  };
}

/** Positive deltas are what send mode would top up. Compared in FARM cents. */
export function positiveTotal(rows: WalletDelta[]) {
  const cents = rows.reduce((sum, row) => {
    if (!(row.deltaFarm > 0)) return sum;
    return sum + Math.round(row.deltaFarm * 100);
  }, 0);
  return cents / 100;
}

export type ReconcileDecision =
  | { ok: true; total: number }
  | { ok: false; reason: string; total: number };

/**
 * Send is refused unless --expect-total matches the dry-run total exactly
 * (to the FARM cent) and no wallet or the batch exceeds the caps.
 * Dry mode always passes the numeric checks so an operator can read the total.
 */
export function evaluateReconcileSend(input: {
  mode: ReconcileMode;
  rows: WalletDelta[];
  expectTotal?: number;
  caps?: ReconcileCaps;
}): ReconcileDecision {
  const caps = input.caps ?? reconcileCaps();
  const total = positiveTotal(input.rows);
  if (input.mode === 'dry') return { ok: true, total };
  if (input.expectTotal == null || !Number.isFinite(input.expectTotal)) {
    return {
      ok: false,
      total,
      reason:
        'Send mode requires --expect-total equal to the dry-run total. Run dry first.',
    };
  }
  const expected = Math.round(input.expectTotal * 100);
  const actual = Math.round(total * 100);
  if (expected !== actual) {
    return {
      ok: false,
      total,
      reason: `Refusing send: --expect-total ${input.expectTotal} does not match dry-run total ${total}`,
    };
  }
  const over = input.rows.find((row) => row.deltaFarm > caps.maxPerWallet);
  if (over) {
    return {
      ok: false,
      total,
      reason: `Refusing send: a wallet delta exceeds the per-wallet cap of ${caps.maxPerWallet} FARM`,
    };
  }
  if (total > caps.maxTotal) {
    return {
      ok: false,
      total,
      reason: `Refusing send: dry-run total exceeds the batch cap of ${caps.maxTotal} FARM`,
    };
  }
  return { ok: true, total };
}

export function parseReconcileArgs(argv: string[]) {
  const read = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const modeRaw = (read('mode') ?? 'dry').toLowerCase();
  const mode: ReconcileMode = modeRaw === 'send' ? 'send' : 'dry';
  const limit = Math.min(500, Math.max(1, Number(read('limit') ?? 100) || 100));
  const expectRaw = read('expect-total');
  const expectTotal =
    expectRaw == null || expectRaw === '' ? undefined : Number(expectRaw);
  return { mode, limit, expectTotal };
}

export function parseCreditArgs(argv: string[]) {
  const read = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const tx = (read('tx') ?? '').trim();
  const modeRaw = (read('mode') ?? 'dry').toLowerCase();
  const send = modeRaw === 'send';
  const asset = (read('asset') ?? '').trim().toUpperCase() || undefined;
  const network = (read('network') ?? '').trim() || undefined;
  return { tx, send, asset, network };
}
