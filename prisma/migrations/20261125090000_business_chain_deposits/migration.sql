-- Additive: route on-chain deposits received by business Algorand accounts.
ALTER TABLE "chain_deposits" ADD COLUMN IF NOT EXISTS "business_wallet_id" UUID;
CREATE INDEX IF NOT EXISTS "chain_deposits_business_wallet_id_idx" ON "chain_deposits"("business_wallet_id");
