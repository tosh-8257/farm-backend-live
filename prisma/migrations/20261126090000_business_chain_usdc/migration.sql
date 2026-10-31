-- Additive: USDC opt-in for business Algorand accounts.
ALTER TABLE "business_chain_wallets" ADD COLUMN IF NOT EXISTS "usdc_opt_in_tx" VARCHAR(64);
