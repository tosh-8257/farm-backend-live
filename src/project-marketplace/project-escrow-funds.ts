import { BadRequestException } from '@nestjs/common';
import { autoPayoutsEnabled } from './funds-flow-rules';
import { FARM_DECIMALS } from '../chain-wallet/chain-config';

type Tx = any;

/**
 * Put an escrow refund back into the project's locked balance
 * (released_amount decreases). Does not credit the owner's wallet.
 */
export async function returnProjectEscrowFunds(
  tx: Tx,
  input: {
    projectId: string;
    amount: number;
    escrowId: string;
    actor?: string;
  },
) {
  const amount = Number(input.amount);
  if (!(amount > 0)) return { returned: 0 };
  const claimed = await tx.$executeRaw`
    UPDATE investment_projects
       SET released_amount = COALESCE(released_amount, 0) - ${amount},
           updated_at = now()
     WHERE id = ${input.projectId}::uuid
       AND COALESCE(released_amount, 0) >= ${amount}`;
  if (claimed !== 1) {
    throw new BadRequestException(
      'Project locked funds could not accept this escrow refund',
    );
  }
  await tx.project_spends.updateMany({
    where: {
      project_id: input.projectId,
      target_kind: 'escrow',
      target_id: input.escrowId,
    },
    data: { refunded_at: new Date(), refunded_amount: amount },
  });
  await tx.project_funds_audit.create({
    data: {
      project_id: input.projectId,
      action: 'escrow_refund',
      actor: input.actor ?? 'system',
      amount: -amount,
      detail: { escrow_id: input.escrowId },
    },
  });
  return { returned: amount };
}

/** Queue the seller payout on the project escrow account. No-op when auto payouts are off. */
export async function enqueueProjectEscrowRelease(
  db: Tx,
  input: {
    projectId: string;
    sellerUserId: string;
    amount: number;
    escrowId: string;
  },
) {
  if (!autoPayoutsEnabled()) return null;
  const units = BigInt(Math.round(input.amount * 10 ** FARM_DECIMALS));
  if (units <= 0n) return null;
  const escrow = await db.project_escrows.findUnique({
    where: { project_id: input.projectId },
  });
  if (!escrow || escrow.status !== 'ready') return null;
  const dest = await db.user_chain_wallets.findUnique({
    where: { user_id: input.sellerUserId },
  });
  const reserve = process.env.FARM_RESERVE_ADDRESS;
  const to = dest?.status === 'ready' ? dest.address : reserve;
  if (!to || to === escrow.address) return null;
  try {
    return await db.project_chain_moves.create({
      data: {
        project_id: input.projectId,
        kind: 'spend',
        ref_id: input.escrowId,
        from_address: escrow.address,
        to_address: to,
        units,
        move_key: `escrow-release:${input.escrowId}:${units.toString()}`,
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') return null;
    throw err;
  }
}
