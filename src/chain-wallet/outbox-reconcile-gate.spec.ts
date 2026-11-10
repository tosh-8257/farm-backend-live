import {
  isInsufficientFarmBlock,
  outboxBlocksReconcile,
} from './outbox-reconcile-gate';

const short = {
  status: 'blocked',
  last_error: 'sender has not enough FARM on chain yet (run reconciliation)',
};

describe('reconcile outbox gate', () => {
  it('treats only the insufficient-FARM block as safe to top up past', () => {
    expect(isInsufficientFarmBlock(short)).toBe(true);
    expect(
      isInsufficientFarmBlock({
        status: 'blocked',
        last_error: 'destination is not a FARM account',
      }),
    ).toBe(false);
    expect(
      isInsufficientFarmBlock({
        status: 'pending',
        last_error: short.last_error,
      }),
    ).toBe(false);
  });

  it('allows execute when every open row is an insufficient-balance block', () => {
    expect(outboxBlocksReconcile([short, short])).toEqual({ ok: true });
    expect(outboxBlocksReconcile([])).toEqual({ ok: true });
  });

  it('still refuses pending, submitting, sending, and other failures', () => {
    expect(
      outboxBlocksReconcile([short, { status: 'pending', last_error: null }]),
    ).toEqual({
      ok: false,
      reason:
        '1 on-chain transfer is still in flight (pending or submitting); run again when the outbox is drained',
    });
    expect(
      outboxBlocksReconcile([{ status: 'submitting', last_error: null }]).ok,
    ).toBe(false);
    expect(
      outboxBlocksReconcile([{ status: 'sending', last_error: null }]).ok,
    ).toBe(false);
    expect(
      outboxBlocksReconcile([{ status: 'failed', last_error: 'node down' }]).ok,
    ).toBe(false);
  });
});
