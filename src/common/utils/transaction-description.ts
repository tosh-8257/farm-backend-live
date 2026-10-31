const METHOD_LABELS: Record<string, string> = {
  MOBILE_MONEY: 'Mobile money',
  CARD: 'Card',
  BANK: 'Bank',
  BANK_TRANSFER: 'Bank transfer',
  CRYPTO: 'Crypto',
};

const PROVIDER_LABELS: Record<string, string> = {
  PAYSTACK: 'Paystack',
  NOWPAYMENTS: 'NOWPayments',
  IVORYPAY: 'Ivorypay',
  MPESA: 'M-Pesa',
};

/**
 * Status is shown by its own badge, so descriptions must not carry a
 * status word. Strips the legacy "Pending " prefix that older rows were
 * stored with and tidies enum-style tokens. Display only; stored rows
 * are never modified.
 */
export function cleanTransactionDescription(
  description: string | null | undefined,
): string | null | undefined {
  if (typeof description !== 'string') return description;
  let out = description.trim().replace(/^pending\s+/i, '');
  // Legacy NOWPayments wording.
  out = out.replace(
    /^NOWPayments crypto deposit\b/,
    'Crypto deposit via NOWPayments',
  );
  out = out.replace(
    /^NOWPayments crypto withdrawal\b/,
    'Crypto withdrawal via NOWPayments',
  );
  // "MOBILE_MONEY deposit via PAYSTACK" -> "Mobile money deposit via Paystack"
  out = out.replace(
    /^([A-Z_]{3,}) (deposit|withdrawal)\b/,
    (m, method: string, kind: string) =>
      METHOD_LABELS[method] ? `${METHOD_LABELS[method]} ${kind}` : m,
  );
  out = out.replace(/\bvia ([A-Z_]{3,})\b/, (m, p: string) =>
    PROVIDER_LABELS[p] ? `via ${PROVIDER_LABELS[p]}` : m,
  );
  if (out.length > 0) out = out[0].toUpperCase() + out.slice(1);
  return out;
}
