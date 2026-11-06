import {
  evaluateReconcileSend,
  parseCreditArgs,
  parseReconcileArgs,
  positiveTotal,
} from './reconcile-policy';

const rows = [
  { key: 'a', address: 'A', deltaFarm: 10.5 },
  { key: 'b', address: 'B', deltaFarm: -2 },
  { key: 'c', address: 'C', deltaFarm: 4.25 },
];

describe('reconcile operator policy', () => {
  it('defaults to dry and parses expect-total', () => {
    expect(parseReconcileArgs([])).toEqual({
      mode: 'dry',
      limit: 100,
      expectTotal: undefined,
    });
    expect(
      parseReconcileArgs(['--mode=send', '--limit=3', '--expect-total=14.75']),
    ).toEqual({ mode: 'send', limit: 3, expectTotal: 14.75 });
    expect(parseReconcileArgs(['--mode=execute'])).toMatchObject({
      mode: 'dry',
    });
  });

  it('sums only positive top-ups', () => {
    expect(positiveTotal(rows)).toBe(14.75);
  });

  it('refuses send unless expect-total matches and caps hold', () => {
    expect(
      evaluateReconcileSend({ mode: 'send', rows, expectTotal: 14.74 }).ok,
    ).toBe(false);
    expect(evaluateReconcileSend({ mode: 'send', rows }).ok).toBe(false);
    expect(
      evaluateReconcileSend({
        mode: 'send',
        rows,
        expectTotal: 14.75,
        caps: { maxPerWallet: 10, maxTotal: 100 },
      }).ok,
    ).toBe(false);
    expect(
      evaluateReconcileSend({
        mode: 'send',
        rows,
        expectTotal: 14.75,
        caps: { maxPerWallet: 100, maxTotal: 14 },
      }).ok,
    ).toBe(false);
    expect(
      evaluateReconcileSend({ mode: 'send', rows, expectTotal: 14.75 }),
    ).toEqual({ ok: true, total: 14.75 });
    expect(evaluateReconcileSend({ mode: 'dry', rows }).ok).toBe(true);
  });

  it('parses a single-deposit credit and stays dry by default', () => {
    expect(parseCreditArgs(['--tx=ABC'])).toEqual({
      tx: 'ABC',
      send: false,
      asset: undefined,
      network: undefined,
    });
    expect(
      parseCreditArgs(['--tx=ABC', '--mode=send', '--asset=farm']),
    ).toMatchObject({ tx: 'ABC', send: true, asset: 'FARM' });
  });
});
