export type BackfillMode = 'dry' | 'send';

/** Min-balance funding transferred to each new custodial account. */
export const DEFAULT_FUND_MICROALGOS = 310_000n;

export function fundMicroAlgos(
  env: Record<string, string | undefined> = process.env,
): bigint {
  const raw =
    env.CHAIN_WALLET_FUND_MICROALGOS ?? String(DEFAULT_FUND_MICROALGOS);
  try {
    const n = BigInt(raw.trim());
    return n > 0n ? n : DEFAULT_FUND_MICROALGOS;
  } catch {
    return DEFAULT_FUND_MICROALGOS;
  }
}

export function backfillCost(selected: number, each: bigint): bigint {
  const count = BigInt(Math.max(0, Math.floor(selected)));
  return count * each;
}

export type BackfillDecision =
  | { ok: true; selected: number }
  | { ok: false; reason: string; selected: number };

/**
 * Send is refused unless --expect-count equals the dry-run selected count
 * for the same --limit (users this run would provision, FARM balances first).
 */
export function evaluateBackfillSend(input: {
  mode: BackfillMode;
  selected: number;
  expectCount?: number;
}): BackfillDecision {
  if (input.mode === 'dry') return { ok: true, selected: input.selected };
  if (input.expectCount == null || !Number.isInteger(input.expectCount)) {
    return {
      ok: false,
      selected: input.selected,
      reason:
        'Send mode requires --expect-count equal to the dry-run selected count. Run dry first.',
    };
  }
  if (input.expectCount !== input.selected) {
    return {
      ok: false,
      selected: input.selected,
      reason: `Refusing send: --expect-count ${input.expectCount} does not match dry-run selected count ${input.selected}`,
    };
  }
  return { ok: true, selected: input.selected };
}

export function parseBackfillArgs(argv: string[]) {
  const read = (name: string) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : undefined;
  };
  const modeRaw = (read('mode') ?? 'dry').toLowerCase();
  const mode: BackfillMode = modeRaw === 'send' ? 'send' : 'dry';
  const limitRaw = Number(read('limit') ?? 25);
  const limit = Math.min(
    500,
    Math.max(1, Math.floor(Number.isFinite(limitRaw) ? limitRaw : 25) || 25),
  );
  const expectRaw = read('expect-count');
  const expectCount =
    expectRaw == null || expectRaw === '' ? undefined : Number(expectRaw);
  return { mode, limit, expectCount };
}
