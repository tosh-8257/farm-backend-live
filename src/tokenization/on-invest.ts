import { ConflictException } from '@nestjs/common';
import { algorandConfig } from './algorand-config';
import { chainConfig } from '../chain-wallet/chain-config';

/**
 * "Tokenize at listing, deliver as they invest". OFF unless
 * TOKENIZE_ON_INVEST_ENABLED=true AND tokenization itself is configured
 * (TestNet only, see algorand-config). Delivery additionally needs custodial
 * chain wallets on the SAME network as the token.
 */
export function onInvestConfig(env: NodeJS.ProcessEnv = process.env) {
  const tok = algorandConfig(env);
  const enabled = env.TOKENIZE_ON_INVEST_ENABLED === 'true' && tok.enabled;
  const chain = chainConfig(env);
  return {
    enabled,
    network: tok.network,
    delivery: enabled && chain.wallets.enabled && chain.network === tok.network,
    missing: [
      ...(env.TOKENIZE_ON_INVEST_ENABLED === 'true'
        ? []
        : ['TOKENIZE_ON_INVEST_ENABLED']),
      ...tok.missing,
    ],
    problems: tok.problems,
  };
}

/** Project statuses in which a business may request on-invest tokenization. */
export const ON_INVEST_REQUESTABLE = [
  'draft',
  'more_info_required',
  'submitted',
  'approved',
];
/** Min ALGO a wallet must be able to spend before an ASA opt-in (0.1 + fee). */
export const OPT_IN_NEED = 101_000n;
export const MAX_ATTEMPTS = 10;

/** 1 token = 1 FARM; fractional FARM is not tokenized. */
export const unitsFor = (amount: number | string | null | undefined) => {
  const n = Math.floor(Number(amount ?? 0) + 1e-9);
  return BigInt(n > 0 ? n : 0);
};

/**
 * Called inside the investment DB transaction (same tx as the debit and the
 * capacity claim, which already caps raised_amount at target_amount). Records
 * an 'owed' allocation when the project has an on-invest token that exists
 * on-chain. Never touches the chain.
 */
export async function allocateOnInvestInTx(
  tx: any,
  p: {
    projectId: string;
    investmentId: string;
    userId: string;
    amount: number;
  },
) {
  const t = await tx.project_tokens.findUnique({
    where: { project_id: p.projectId },
  });
  if (!t || t.mode !== 'on_invest' || t.status !== 'created') return null;
  const units = unitsFor(p.amount);
  if (units <= 0n) return null;
  // Defensive supply cap: never allocate beyond total_units.
  const agg = await tx.token_allocations.aggregate({
    where: {
      project_token_id: t.id,
      status: { notIn: ['cancelled', 'clawed_back'] },
    },
    _sum: { units: true },
  });
  const used = BigInt(agg._sum?.units ?? 0);
  if (used + units > BigInt(t.total_units))
    throw new ConflictException('Token supply exhausted for this project');
  return tx.token_allocations.create({
    data: {
      project_token_id: t.id,
      investment_id: p.investmentId,
      user_id: p.userId,
      units,
      custody: 'issuer',
      status: 'owed',
    },
  });
}
