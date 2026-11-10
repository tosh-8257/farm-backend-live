/** Collected platform fee from stored rows. Periods are measured back from `now`. */
export type FeePeriod = 'all' | 'day' | 'week' | 'month';

export type FeeTotals = { total: number; count: number };

export type FeeStream = {
  type: string;
  label: string;
  source: string;
  note?: string;
  total: number;
  count: number;
  periods: Record<FeePeriod, FeeTotals>;
};

export const FEE_CATALOG: {
  type: string;
  label: string;
  source: string;
  note?: string;
}[] = [
  {
    type: 'transfer',
    label: 'Transfer and send fees',
    source: 'transactions.fee where type is transfer',
  },
  {
    type: 'withdrawal',
    label: 'Withdrawal and cash-out fees',
    source:
      'transactions.fee where type is withdrawal, including crypto cash-out',
  },
  {
    type: 'deposit',
    label: 'Deposit fees',
    source: 'transactions.fee where type is deposit',
  },
  {
    type: 'merchant_payment',
    label: 'Merchant QR and hosted checkout fees',
    source: 'transactions.fee where type is merchant_payment',
  },
  {
    type: 'merchant_invoice',
    label: 'Invoice merchant fees',
    source:
      'transactions.metadata.merchant_fee on transfers described as invoices',
  },
  {
    type: 'merchant_payment_link',
    label: 'Payment link merchant fees',
    source:
      'transactions.metadata.merchant_fee on transfers described as payment links',
  },
  {
    type: 'merchant_nfc',
    label: 'NFC and other in-app merchant fees',
    source: 'transactions.metadata.merchant_fee on other transfers',
  },
  {
    type: 'escrow_lock',
    label: 'Escrow creation fees',
    source:
      'transactions.fee where type is escrow_lock, excluding travel bookings',
  },
  {
    type: 'escrow_release',
    label: 'Escrow release fees',
    source: 'transactions.fee where type is escrow_release',
  },
  {
    type: 'investment',
    label: 'Investment fees',
    source: 'transactions.fee where type is investment',
  },
  {
    type: 'project_consolidation',
    label: 'Project consolidation fund',
    source:
      'transactions.amount where type is fee and metadata.category is consolidation_fund',
  },
  {
    type: 'token_distribution',
    label: 'Token income fee',
    source: 'transactions.fee where type is token_distribution (default 2%)',
  },
  {
    type: 'token_transfer',
    label: 'Token trade fees',
    source: 'transactions.fee on token transfers',
    note: 'Token transfers charge no platform fee. Network fees are paid by FARM.',
  },
  {
    type: 'travel',
    label: 'Travel commission',
    source:
      'transactions.fee on escrow holds whose metadata.kind starts with travel',
  },
  {
    type: 'mkulima_usage',
    label: 'Mkulima AI margin',
    source: 'transactions.fee where type is mkulima_usage',
  },
  {
    type: 'agent_payment',
    label: 'Agent payment fees',
    source: 'transactions.fee where metadata.kind is agent_payment_request',
    note: 'Agent payments do not add a platform fee.',
  },
  {
    type: 'x402',
    label: 'x402 platform fees',
    source: 'none',
    note: 'x402 does not charge a platform fee. Sponsored network fees are a cost.',
  },
  {
    type: 'swap',
    label: 'Crypto and swap fees',
    source: 'transactions.fee where type is swap',
    note: 'There is no separate swap fee. Crypto cash-out uses the withdrawal fee. Crypto deposits have no platform fee.',
  },
  {
    type: 'fx_spread',
    label: 'FX spread',
    source: 'none',
    note: 'The FX spread is inside the conversion rate and is not stored as its own fee.',
  },
  {
    type: 'received_chain',
    label: 'On-chain receive fees',
    source: 'transactions.fee on chain deposits',
    note: 'Incoming chain deposits are credited without a platform fee.',
  },
];

const money = (n: number) => Number(Number(n || 0).toFixed(8));

export function emptyPeriods(): Record<FeePeriod, FeeTotals> {
  return {
    all: { total: 0, count: 0 },
    day: { total: 0, count: 0 },
    week: { total: 0, count: 0 },
    month: { total: 0, count: 0 },
  };
}

export function periodsFor(
  at: Date | string | null | undefined,
  now: Date,
): FeePeriod[] {
  const time = at ? new Date(at).getTime() : now.getTime();
  const startToday = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const out: FeePeriod[] = ['all'];
  if (time >= startToday) out.push('day');
  if (time >= now.getTime() - 7 * 86_400_000) out.push('week');
  if (time >= now.getTime() - 30 * 86_400_000) out.push('month');
  return out;
}

function add(
  bucket: FeeStream,
  amount: number,
  at: Date | string | null | undefined,
  now: Date,
) {
  if (!(amount > 0)) return;
  const value = money(amount);
  for (const period of periodsFor(at, now)) {
    bucket.periods[period].total = money(bucket.periods[period].total + value);
    bucket.periods[period].count += 1;
  }
  bucket.total = bucket.periods.all.total;
  bucket.count = bucket.periods.all.count;
}

function meta(row: { metadata?: unknown }): Record<string, unknown> {
  const value = row.metadata;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export type FeeRow = {
  transaction_type?: string | null;
  status?: string | null;
  fee?: unknown;
  amount?: unknown;
  description?: string | null;
  metadata?: unknown;
  created_at?: Date | string | null;
};

export type FeeGroup = {
  transaction_type?: string | null;
  _sum?: { fee?: unknown };
  _count?: { id?: unknown };
};

export function catalogStreams(): Map<string, FeeStream> {
  const streams = new Map<string, FeeStream>();
  for (const item of FEE_CATALOG) {
    streams.set(item.type, {
      ...item,
      total: 0,
      count: 0,
      periods: emptyPeriods(),
    });
  }
  return streams;
}

export function addGroup(
  streams: Map<string, FeeStream>,
  groups: FeeGroup[],
  period: FeePeriod,
) {
  for (const group of groups) {
    const type = String(group.transaction_type ?? 'other');
    const total = money(num(group._sum?.fee));
    const count = Number(group._count?.id ?? 0);
    if (!(total > 0)) continue;
    let stream = streams.get(type);
    if (!stream) {
      stream = {
        type,
        label: `${type.replace(/_/g, ' ')} fees`,
        source: 'transactions.fee',
        total: 0,
        count: 0,
        periods: emptyPeriods(),
      };
      streams.set(type, stream);
    }
    stream.periods[period].total = money(stream.periods[period].total + total);
    stream.periods[period].count += count;
    if (period === 'all') {
      stream.total = stream.periods.all.total;
      stream.count = stream.periods.all.count;
    }
  }
}

/**
 * groupBy already counted completed transactions.fee. These rows add fees
 * stored in metadata or amount, and move travel commission out of escrow.
 */
export function applyFeeRows(
  streams: Map<string, FeeStream>,
  rows: FeeRow[],
  now: Date,
) {
  for (const row of rows) {
    const info = meta(row);
    const at = row.created_at ?? null;
    const kind = typeof info.kind === 'string' ? info.kind : '';
    const fee = num(row.fee);
    if (
      row.transaction_type === 'escrow_lock' &&
      kind.startsWith('travel') &&
      fee > 0
    ) {
      const escrow = streams.get('escrow_lock');
      if (escrow) {
        for (const period of periodsFor(at, now)) {
          escrow.periods[period].total = money(
            Math.max(0, escrow.periods[period].total - fee),
          );
          escrow.periods[period].count = Math.max(
            0,
            escrow.periods[period].count - 1,
          );
        }
        escrow.total = escrow.periods.all.total;
        escrow.count = escrow.periods.all.count;
      }
      add(streams.get('travel')!, fee, at, now);
      continue;
    }
    if (row.transaction_type === 'transfer') {
      const merchantFee = num(info.merchant_fee);
      const description = row.description ?? '';
      const type = description.startsWith('Invoice ')
        ? 'merchant_invoice'
        : description.startsWith('Payment link')
          ? 'merchant_payment_link'
          : 'merchant_nfc';
      add(streams.get(type)!, merchantFee, at, now);
      continue;
    }
    if (
      row.transaction_type === 'fee' &&
      info.category === 'consolidation_fund'
    ) {
      add(streams.get('project_consolidation')!, num(row.amount), at, now);
      continue;
    }
    if (
      row.transaction_type === 'mkulima_usage' &&
      row.status === 'pending' &&
      fee > 0
    ) {
      add(streams.get('mkulima_usage')!, fee, at, now);
    }
  }
}

export function listFees(streams: Map<string, FeeStream>): FeeStream[] {
  return [...streams.values()]
    .map((stream) => ({
      ...stream,
      total: stream.periods.all.total,
      count: stream.periods.all.count,
    }))
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

export function feeGrandTotal(streams: FeeStream[]) {
  return money(streams.reduce((sum, stream) => sum + stream.total, 0));
}
