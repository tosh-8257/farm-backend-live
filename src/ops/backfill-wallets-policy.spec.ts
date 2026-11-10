import {
  backfillCost,
  evaluateBackfillSend,
  fundMicroAlgos,
  parseBackfillArgs,
} from './backfill-wallets-policy';

describe('backfill wallet policy', () => {
  it('uses CHAIN_WALLET_FUND_MICROALGOS, defaulting to 0.31 ALGO', () => {
    expect(fundMicroAlgos({})).toBe(310_000n);
    expect(fundMicroAlgos({ CHAIN_WALLET_FUND_MICROALGOS: '500000' })).toBe(
      500_000n,
    );
    expect(fundMicroAlgos({ CHAIN_WALLET_FUND_MICROALGOS: 'nope' })).toBe(
      310_000n,
    );
    expect(backfillCost(3, 310_000n)).toBe(930_000n);
    expect(backfillCost(0, 310_000n)).toBe(0n);
  });

  it('parses dry by default and caps the batch', () => {
    expect(parseBackfillArgs([])).toEqual({
      mode: 'dry',
      limit: 25,
      expectCount: undefined,
    });
    expect(
      parseBackfillArgs(['--mode=send', '--limit=10', '--expect-count=10']),
    ).toEqual({ mode: 'send', limit: 10, expectCount: 10 });
    expect(parseBackfillArgs(['--limit=99999']).limit).toBe(500);
    expect(parseBackfillArgs(['--mode=execute']).mode).toBe('dry');
  });

  it('refuses send unless expect-count matches the selected batch', () => {
    expect(evaluateBackfillSend({ mode: 'dry', selected: 4 }).ok).toBe(true);
    expect(evaluateBackfillSend({ mode: 'send', selected: 4 }).ok).toBe(false);
    expect(
      evaluateBackfillSend({ mode: 'send', selected: 4, expectCount: 9 }),
    ).toEqual({
      ok: false,
      selected: 4,
      reason:
        'Refusing send: --expect-count 9 does not match dry-run selected count 4',
    });
    expect(
      evaluateBackfillSend({ mode: 'send', selected: 4, expectCount: 4 }).ok,
    ).toBe(true);
  });
});
