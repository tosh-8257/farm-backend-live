-- Tokenize at listing, deliver as people invest. Additive only.
ALTER TABLE "project_tokens"
  ADD COLUMN IF NOT EXISTS "mode" VARCHAR(20) NOT NULL DEFAULT 'post_funding',
  ADD COLUMN IF NOT EXISTS "unsold_units" BIGINT,
  ADD COLUMN IF NOT EXISTS "closed_at" TIMESTAMPTZ(6);

ALTER TABLE "token_allocations"
  ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) NOT NULL DEFAULT 'held',
  ADD COLUMN IF NOT EXISTS "address" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "tx_id" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "last_valid" BIGINT,
  ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "error" TEXT,
  ADD COLUMN IF NOT EXISTS "delivered_at" TIMESTAMPTZ(6),
  ADD COLUMN IF NOT EXISTS "clawback_tx_id" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "clawback_last_valid" BIGINT,
  ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS "token_allocations_status_idx" ON "token_allocations" ("status");
