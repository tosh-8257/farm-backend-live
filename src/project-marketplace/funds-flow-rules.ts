/**
 * Project funds flow. Every switch defaults OFF; only variable NAMES are
 * reported, never values.
 *  PROJECT_FUNDS_FLOW_ENABLED   - spend from project funds, returns, timeline
 *  PROJECT_AUTO_PAYOUTS_ENABLED - on-chain escrow mirror + automatic payouts
 *  PROJECT_PAYOUTS_KILL_SWITCH  - "true" stops every spend and payout at once
 */
type Env = Record<string, string | undefined>;

export const fundsFlowEnabled = (env: Env = process.env) =>
  env.PROJECT_FUNDS_FLOW_ENABLED === 'true';

export const killSwitchOn = (env: Env = process.env) =>
  env.PROJECT_PAYOUTS_KILL_SWITCH === 'true';

/** TestNet only: automatic on-chain payouts never run on MainNet. */
export const testnetOnly = (env: Env = process.env) =>
  (env.ALGORAND_NETWORK?.trim() || 'testnet') === 'testnet';

export const autoPayoutsEnabled = (env: Env = process.env) =>
  fundsFlowEnabled(env) &&
  env.PROJECT_AUTO_PAYOUTS_ENABLED === 'true' &&
  !killSwitchOn(env) &&
  testnetOnly(env);

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v != null && Number.isFinite(n) && n >= 0 ? n : d;
};

/** Safety rails (FARM, except the ALGO floor in microALGO). */
export function fundsCaps(env: Env = process.env) {
  return {
    perPayment: num(env.PROJECT_SPEND_MAX_PER_PAYMENT, 10_000),
    perProjectDaily: num(env.PROJECT_PAYOUT_DAILY_CAP, 25_000),
    globalDaily: num(env.PROJECT_PAYOUT_GLOBAL_DAILY_CAP, 100_000),
    funderFloorMicroAlgos: BigInt(
      Math.floor(num(env.PROJECT_FUNDER_FLOOR_MICROALGOS, 2_000_000)),
    ),
    escrowFloorMicroAlgos: BigInt(
      Math.floor(num(env.PROJECT_ESCROW_FLOOR_MICROALGOS, 200_000)),
    ),
  };
}

export const DISTRIBUTION_MODES = [
  'off',
  'monthly',
  'on_deposit',
  'period_end',
] as const;

export const RETURNS_CATEGORY = 'project_returns';
export const SPEND_CATEGORY = 'project_spend';
/** Audit actions that count towards the daily caps. */
export const CAPPED_ACTIONS = ['spend', 'distribution'];
