import { generateTxReference } from '../common/utils/reference.util';
import { creditPlatformInTx, feeFor } from '../fees/fee-defaults';

export const CONSOLIDATION_CATEGORY = 'consolidation_fund';

/**
 * Project consolidation fund fee (user decision, option B): taken ONCE when the
 * funding round closes, as `project_listing`% (default 15) of the total raised.
 * Credited to the main platform wallet with ledger category `consolidation_fund`.
 * It is a per-project REFUNDABLE reserve (insurance): if the project is cancelled
 * or makes a loss, investors get their pro-rata share of what is left of it
 * (consolidation_fee - consolidation_refunded). Never pooled across projects.
 * Idempotent via consolidation_fee_at.
 */
export async function chargeConsolidationInTx(
  tx: any,
  fees: any,
  projectId: string,
  by?: string,
): Promise<number> {
  const p = await tx.investment_projects.findUnique({
    where: { id: projectId },
    select: {
      raised_amount: true,
      consolidation_fee_at: true,
      project_name: true,
    },
  });
  if (!p || p.consolidation_fee_at) return 0;
  const raised = Number(p.raised_amount ?? 0);
  const fee = raised > 0 ? await feeFor(fees, 'project_listing', raised) : 0;
  const claim = await tx.investment_projects.updateMany({
    where: { id: projectId, consolidation_fee_at: null },
    data: { consolidation_fee: fee, consolidation_fee_at: new Date() },
  });
  if (!claim.count || !(fee > 0)) return 0;
  const t = await tx.transactions.create({
    data: {
      transaction_reference: generateTxReference(),
      transaction_type: 'fee', // category in metadata + ledger
      status: 'completed',
      amount: fee,
      fee: 0,
      net_amount: fee,
      description: `Consolidation fund: ${p.project_name ?? projectId}`,
      metadata: {
        project_id: projectId,
        raised,
        category: CONSOLIDATION_CATEGORY,
        by: by ?? 'system',
      },
      processed_at: new Date(),
    },
  });
  await creditPlatformInTx(
    tx,
    fee,
    `Consolidation fund: ${p.project_name ?? projectId}`,
    t.id,
    CONSOLIDATION_CATEGORY,
  );
  return fee;
}

/** Funds still held for the project after the consolidation fee and releases. */
export function heldFunds(p: {
  raised_amount?: any;
  released_amount?: any;
  consolidation_fee?: any;
}) {
  return Math.max(
    0,
    Number(p.raised_amount ?? 0) -
      Number(p.consolidation_fee ?? 0) -
      Number(p.released_amount ?? 0),
  );
}

/** What is left of this project's reserve. */
export function reserveLeft(p: {
  consolidation_fee?: any;
  consolidation_refunded?: any;
  consolidation_released?: any;
  consolidation_bought_back?: any;
}) {
  return Math.max(
    0,
    Number(p.consolidation_fee ?? 0) -
      Number(p.consolidation_refunded ?? 0) -
      Number(p.consolidation_released ?? 0) -
      Number(p.consolidation_bought_back ?? 0),
  );
}

/**
 * Pay `amount` out of one project's reserve: guarded claim on the project row
 * (never more than that project's reserve), then debit the platform wallet with
 * a ledger entry in category consolidation_fund.
 */
export async function payFromReserveInTx(
  tx: any,
  projectId: string,
  amount: number,
  transactionId: string,
) {
  if (!(amount > 0)) return;
  const claimed = await tx.$executeRaw`
    UPDATE investment_projects
       SET consolidation_refunded = consolidation_refunded + ${amount}, updated_at = now()
     WHERE id = ${projectId}::uuid
       AND consolidation_refunded + consolidation_released + consolidation_bought_back + ${amount} <= consolidation_fee`;
  if (claimed !== 1) throw new Error('Consolidation reserve exhausted');
  const admin = await tx.users.findFirst({
    where: { role: 'super_admin', is_deleted: false },
    include: { wallets: { where: { is_active: true }, take: 1 } },
  });
  const w = admin?.wallets?.[0];
  if (!w) throw new Error('Platform wallet not found');
  const before = Number(w.balance ?? 0);
  await tx.wallets.update({
    where: { id: w.id },
    data: { balance: { decrement: amount } },
  });
  await tx.ledger_entries.create({
    data: {
      transaction_id: transactionId,
      wallet_id: w.id,
      entry_type: 'debit',
      amount,
      balance_before: before,
      balance_after: before - amount,
      description: `Consolidation fund refund (project ${projectId})`,
      category: CONSOLIDATION_CATEGORY,
    },
  });
}

export const FARM_REVENUE_CATEGORY = 'fee_revenue';

/**
 * Successful completion: the project's remaining reserve becomes FARM revenue.
 * Money stays in the platform wallet; the ledger records a reclassification
 * (debit consolidation_fund, credit fee_revenue, net 0). Guarded per project.
 */
export async function releaseReserveToFarmInTx(
  tx: any,
  projectId: string,
  amount: number,
  transactionId: string,
) {
  if (!(amount > 0)) return;
  const claimed = await tx.$executeRaw`
    UPDATE investment_projects
       SET consolidation_released = consolidation_released + ${amount}, updated_at = now()
     WHERE id = ${projectId}::uuid
       AND consolidation_refunded + consolidation_released + consolidation_bought_back + ${amount} <= consolidation_fee`;
  if (claimed !== 1) throw new Error('Consolidation reserve exhausted');
  const admin = await tx.users.findFirst({
    where: { role: 'super_admin', is_deleted: false },
    include: { wallets: { where: { is_active: true }, take: 1 } },
  });
  const w = admin?.wallets?.[0];
  if (!w) throw new Error('Platform wallet not found');
  const bal = Number(w.balance ?? 0);
  for (const [entry_type, category] of [
    ['debit', CONSOLIDATION_CATEGORY],
    ['credit', FARM_REVENUE_CATEGORY],
  ]) {
    await tx.ledger_entries.create({
      data: {
        transaction_id: transactionId,
        wallet_id: w.id,
        entry_type,
        amount,
        balance_before: bal,
        balance_after: bal,
        description: `Consolidation reserve released to FARM (project ${projectId})`,
        category,
      },
    });
  }
}

/**
 * Token buyback: pay `amount` out of one project's reserve (guarded claim on
 * the project row, never more than what is left), debit the platform wallet
 * (category consolidation_fund). Returns false if the pool is too small.
 */
export async function payBuybackFromReserveInTx(
  tx: any,
  projectId: string,
  amount: number,
  transactionId: string,
): Promise<boolean> {
  if (!(amount > 0)) return false;
  const claimed = await tx.$executeRaw`
    UPDATE investment_projects
       SET consolidation_bought_back = consolidation_bought_back + ${amount}, updated_at = now()
     WHERE id = ${projectId}::uuid
       AND consolidation_fee_at IS NOT NULL
       AND consolidation_refunded + consolidation_released + consolidation_bought_back + ${amount} <= consolidation_fee`;
  if (claimed !== 1) return false;
  const admin = await tx.users.findFirst({
    where: { role: 'super_admin', is_deleted: false },
    include: { wallets: { where: { is_active: true }, take: 1 } },
  });
  const w = admin?.wallets?.[0];
  if (!w) throw new Error('Platform wallet not found');
  const before = Number(w.balance ?? 0);
  await tx.wallets.update({
    where: { id: w.id },
    data: { balance: { decrement: amount } },
  });
  await tx.ledger_entries.create({
    data: {
      transaction_id: transactionId,
      wallet_id: w.id,
      entry_type: 'debit',
      amount,
      balance_before: before,
      balance_after: before - amount,
      description: `Consolidation fund token buyback (project ${projectId})`,
      category: CONSOLIDATION_CATEGORY,
    },
  });
  return true;
}
