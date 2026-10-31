-- Additive: audit log of automatic ALGO fee top-ups from the funder to FARM
-- custodial wallets. One in-flight top-up per address (partial unique index).
CREATE TABLE IF NOT EXISTS "chain_fee_topups" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "network" VARCHAR(20) NOT NULL,
  "user_id" UUID,
  "address" VARCHAR(64) NOT NULL,
  "micro_algos" BIGINT NOT NULL,
  "spendable_before" BIGINT NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'sending',
  "tx_id" VARCHAR(64) UNIQUE,
  "last_valid" BIGINT,
  "reason" VARCHAR(40),
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_chain_fee_topups_inflight"
  ON "chain_fee_topups" ("address") WHERE "status" = 'sending';
CREATE INDEX IF NOT EXISTS "idx_chain_fee_topups_day"
  ON "chain_fee_topups" ("created_at", "address");
