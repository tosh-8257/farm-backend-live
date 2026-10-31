import { Prisma } from '@prisma/client';
import {
  generateTxReference,
  generateWalletAddress,
} from '../common/utils/reference.util';

/**
 * Business (merchant) wallet, separate from the owner's personal wallet.
 *
 * BUSINESS_WALLET_ENABLED (default off):
 *  - off: unchanged legacy behaviour, every business receipt lands in the
 *    owner's personal wallet and the Business tab shows that wallet.
 *  - on: receipts (QR merchant payments, invoices, payment links, escrow
 *    releases, project-fund payments to the business) credit the business
 *    wallet; the Business tab, merchant dashboard, payouts and project returns
 *    use it; the owner can "Move to personal" for free.
 *
 * The business wallet is a wallets row with wallet_type 'merchant' and
 * user_id NULL (so the ~100 personal lookups `findFirst({ user_id })` never
 * return it), linked from businesses.wallet_id. It is created lazily.
 * Nothing here moves an existing balance.
 */
export const businessWalletEnabled = (
  env: Record<string, string | undefined> = process.env,
) => env.BUSINESS_WALLET_ENABLED === 'true';

type Db = Prisma.TransactionClient | any;

async function personal(db: Db, ownerUserId: string) {
  return (
    (await db.wallets.findFirst({
      where: { user_id: ownerUserId, is_active: true, wallet_type: 'user' },
    })) ??
    (await db.wallets.findFirst({
      where: { user_id: ownerUserId, is_active: true },
    }))
  );
}

/** Owner's personal wallet (never the business wallet). */
export const personalWalletOf = personal;

/** Get or create the business wallet for an approved business. */
export async function ensureBusinessWallet(
  db: Db,
  business: {
    id: string;
    wallet_id?: string | null;
    trading_name?: string | null;
    legal_name?: string | null;
  },
) {
  const linked = business.wallet_id
    ? await db.wallets.findUnique({ where: { id: business.wallet_id } })
    : null;
  if (linked) return linked;
  const fresh = await db.businesses.findUnique({
    where: { id: business.id },
    select: { wallet_id: true, trading_name: true, legal_name: true },
  });
  if (fresh?.wallet_id) {
    const w = await db.wallets.findUnique({ where: { id: fresh.wallet_id } });
    if (w) return w;
  }
  const name = fresh?.trading_name || fresh?.legal_name || 'Business';
  const w = await db.wallets.create({
    data: {
      user_id: null,
      wallet_name: `${name} (Business)`.slice(0, 255),
      wallet_type: 'merchant',
      wallet_address: generateWalletAddress(
        'BIZ',
        business.id.replace(/-/g, ''),
      ),
      currency: 'FARM',
    },
  });
  // Race-safe link: only the first writer wins; a loser deactivates its row.
  const linkedNow = await db.businesses.updateMany({
    where: { id: business.id, wallet_id: null },
    data: { wallet_id: w.id },
  });
  if (!linkedNow.count) {
    await db.wallets.update({
      where: { id: w.id },
      data: { is_active: false },
    });
    const again = await db.businesses.findUnique({
      where: { id: business.id },
      select: { wallet_id: true },
    });
    return db.wallets.findUnique({ where: { id: again!.wallet_id! } });
  }
  return w;
}

/**
 * Where money paid TO a business should land.
 * Flag off -> owner's personal wallet (legacy). Flag on -> business wallet
 * (if the owner has an approved business; otherwise personal).
 */
export async function settlementWalletFor(
  db: Db,
  key: {
    ownerUserId?: string | null;
    businessId?: string | null;
    merchantId?: string | null;
  },
) {
  let ownerUserId = key.ownerUserId ?? null;
  if (businessWalletEnabled()) {
    const where = key.businessId
      ? { id: key.businessId }
      : key.merchantId
        ? { merchant_id: key.merchantId }
        : ownerUserId
          ? { owner_user_id: ownerUserId }
          : null;
    const b = where
      ? await db.businesses.findFirst({
          where,
          select: {
            id: true,
            wallet_id: true,
            status: true,
            owner_user_id: true,
            trading_name: true,
            legal_name: true,
          },
        })
      : null;
    if (b?.status === 'approved') return ensureBusinessWallet(db, b);
    ownerUserId = ownerUserId ?? b?.owner_user_id ?? null;
  }
  if (!ownerUserId && key.merchantId) {
    const m = await db.merchants.findUnique({
      where: { id: key.merchantId },
      select: { user_id: true },
    });
    ownerUserId = m?.user_id ?? null;
  }
  return ownerUserId ? personal(db, ownerUserId) : null;
}

/**
 * Free internal move between two wallets in one DB transaction (no fee).
 * Throws if the source's available balance (balance - locked) would go negative.
 */
export async function internalMove(
  prisma: any,
  p: {
    fromId: string;
    toId: string;
    amount: number;
    kind: string;
    description: string;
    metadata?: Record<string, unknown>;
  },
) {
  return prisma.$transaction(async (tx: any) => {
    await tx.wallets.update({
      where: { id: p.fromId },
      data: { balance: { decrement: p.amount } },
    });
    const from = await tx.wallets.findUnique({ where: { id: p.fromId } });
    if (Number(from.balance) - Number(from.locked_balance) < 0)
      throw new Error('INSUFFICIENT_BUSINESS_BALANCE');
    const to = await tx.wallets.update({
      where: { id: p.toId },
      data: { balance: { increment: p.amount } },
    });
    const t = await tx.transactions.create({
      data: {
        transaction_reference: generateTxReference(),
        sender_wallet_id: p.fromId,
        receiver_wallet_id: p.toId,
        transaction_type: 'transfer',
        status: 'completed',
        amount: p.amount,
        fee: 0,
        net_amount: p.amount,
        description: p.description,
        metadata: { kind: p.kind, ...(p.metadata ?? {}) },
        processed_at: new Date(),
      },
    });
    await tx.ledger_entries.createMany({
      data: [
        {
          transaction_id: t.id,
          wallet_id: p.fromId,
          entry_type: 'debit',
          amount: p.amount,
          balance_before: Number(from.balance) + p.amount,
          balance_after: Number(from.balance),
          description: p.description,
          category: p.kind,
        },
        {
          transaction_id: t.id,
          wallet_id: p.toId,
          entry_type: 'credit',
          amount: p.amount,
          balance_before: Number(to.balance) - p.amount,
          balance_after: Number(to.balance),
          description: p.description,
          category: p.kind,
        },
      ],
    });
    return t;
  });
}
