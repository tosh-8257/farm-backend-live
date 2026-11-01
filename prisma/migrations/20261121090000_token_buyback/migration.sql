-- Token buyback from the per-project 15% consolidation reserve. Additive only.
ALTER TABLE "investment_projects"
  ADD COLUMN IF NOT EXISTS "consolidation_bought_back" DECIMAL(30,8) NOT NULL DEFAULT 0;
ALTER TABLE "user_investments"
  ADD COLUMN IF NOT EXISTS "sold_back_amount" DECIMAL(30,8) NOT NULL DEFAULT 0;
ALTER TABLE "token_allocations"
  ADD COLUMN IF NOT EXISTS "sold_units" BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "token_buybacks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "allocation_id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "units" BIGINT NOT NULL,
  "amount" DECIMAL(30,8) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'requested',
  "from_status" VARCHAR(20) NOT NULL,
  "address" VARCHAR(64),
  "tx_id" VARCHAR(64),
  "last_valid" BIGINT,
  "transaction_id" UUID,
  "reviewed_by" UUID,
  "notes" TEXT,
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "token_buybacks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "token_buybacks_project_id_status_idx" ON "token_buybacks" ("project_id", "status");
CREATE INDEX IF NOT EXISTS "token_buybacks_user_id_idx" ON "token_buybacks" ("user_id");
CREATE INDEX IF NOT EXISTS "token_buybacks_status_idx" ON "token_buybacks" ("status");
-- At most one open buyback per allocation.
CREATE UNIQUE INDEX IF NOT EXISTS "token_buybacks_one_open_per_allocation"
  ON "token_buybacks" ("allocation_id")
  WHERE "status" IN ('requested', 'approved', 'returning');

-- Business accepted the 15% buyback hold-back when requesting tokenization.
ALTER TABLE "project_tokens" ADD COLUMN IF NOT EXISTS "buyback_commitment_at" TIMESTAMPTZ(6);
