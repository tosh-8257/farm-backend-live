-- Additive only. Links a business to its own merchant settlement wallet
-- (wallets.wallet_type = 'merchant', user_id NULL so personal-wallet lookups
-- by user_id never pick it up). No existing balance is moved.
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "wallet_id" UUID;
CREATE UNIQUE INDEX IF NOT EXISTS "businesses_wallet_id_key" ON "businesses"("wallet_id");
