-- Additive only. Links a business to its own merchant settlement wallet
-- (wallets.wallet_type = 'merchant', user_id NULL so personal-wallet lookups
-- by user_id never pick it up). No existing balance is moved.
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "wallet_id" UUID;
CREATE UNIQUE INDEX IF NOT EXISTS "businesses_wallet_id_key" ON "businesses"("wallet_id");

-- Custodial Algorand account per business wallet (same envelope as
-- user_chain_wallets / project_escrows: seed sealed with
-- WALLET_KEY_ENCRYPTION_KEY, bound to the address via AAD).
CREATE TABLE IF NOT EXISTS "business_chain_wallets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "business_id" UUID NOT NULL,
  "wallet_id" UUID NOT NULL,
  "network" VARCHAR(20) NOT NULL,
  "address" VARCHAR(64) NOT NULL,
  "enc_secret" TEXT NOT NULL,
  "enc_iv" VARCHAR(32) NOT NULL,
  "enc_tag" VARCHAR(32) NOT NULL,
  "key_version" INTEGER NOT NULL DEFAULT 1,
  "key_scheme" VARCHAR(16) NOT NULL DEFAULT 'ed25519',
  "funded_tx_id" VARCHAR(64),
  "farm_opt_in_tx" VARCHAR(64),
  "status" VARCHAR(20) NOT NULL DEFAULT 'created',
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "business_chain_wallets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "business_chain_wallets_business_id_key" ON "business_chain_wallets"("business_id");
CREATE UNIQUE INDEX IF NOT EXISTS "business_chain_wallets_wallet_id_key" ON "business_chain_wallets"("wallet_id");
CREATE UNIQUE INDEX IF NOT EXISTS "business_chain_wallets_address_key" ON "business_chain_wallets"("address");
