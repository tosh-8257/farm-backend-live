-- Additive: failed provision attempts, so the retry job can back off.
ALTER TABLE "user_chain_wallets"
  ADD COLUMN IF NOT EXISTS "provision_attempts" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "user_chain_wallets_status_idx"
  ON "user_chain_wallets" ("status");
