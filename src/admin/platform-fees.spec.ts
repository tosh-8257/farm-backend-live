import {
  applyFeeRows,
  catalogStreams,
  feeGrandTotal,
  listFees,
} from './platform-fees';

describe('platform fee report', () => {
  const now = new Date('2026-11-10T12:00:00Z');

  it('counts invoice, link, and other merchant fees stored outside transactions.fee', () => {
    const streams = catalogStreams();
    applyFeeRows(
      streams,
      [
        {
          transaction_type: 'transfer',
          status: 'completed',
          fee: 0,
          description: 'Invoice INV-1',
          metadata: { merchant_fee: 1.5 },
          created_at: now,
        },
        {
          transaction_type: 'transfer',
          status: 'completed',
          fee: 0,
          description: 'Payment link: Till',
          metadata: { merchant_fee: 2 },
          created_at: now,
        },
        {
          transaction_type: 'transfer',
          status: 'completed',
          fee: 0,
          description: 'NFC tap',
          metadata: { merchant_fee: 0.25 },
          created_at: now,
        },
      ],
      now,
    );
    const byType = Object.fromEntries(
      listFees(streams).map((fee) => [fee.type, fee.total]),
    );
    expect(byType.merchant_invoice).toBe(1.5);
    expect(byType.merchant_payment_link).toBe(2);
    expect(byType.merchant_nfc).toBe(0.25);
    expect(byType.transfer).toBe(0);
    expect(byType.fx_spread).toBe(0);
    expect(byType.x402).toBe(0);
    expect(feeGrandTotal(listFees(streams))).toBe(3.75);
  });

  it('moves travel commission out of escrow and counts consolidation and pending Mkulima once', () => {
    const streams = catalogStreams();
    streams.get('escrow_lock')!.periods.all = { total: 10, count: 2 };
    streams.get('escrow_lock')!.total = 10;
    streams.get('escrow_lock')!.count = 2;
    applyFeeRows(
      streams,
      [
        {
          transaction_type: 'escrow_lock',
          status: 'completed',
          fee: 4,
          metadata: { kind: 'travel_flight' },
          created_at: now,
        },
        {
          transaction_type: 'fee',
          status: 'completed',
          fee: 0,
          amount: 15,
          metadata: { category: 'consolidation_fund' },
          created_at: now,
        },
        {
          transaction_type: 'mkulima_usage',
          status: 'pending',
          fee: 0.2,
          created_at: now,
        },
      ],
      now,
    );
    const byType = Object.fromEntries(
      listFees(streams).map((fee) => [fee.type, fee]),
    );
    expect(byType.escrow_lock.total).toBe(6);
    expect(byType.travel.total).toBe(4);
    expect(byType.project_consolidation.total).toBe(15);
    expect(byType.mkulima_usage.total).toBe(0.2);
    expect(byType.travel.periods.day.total).toBe(4);
  });
});
