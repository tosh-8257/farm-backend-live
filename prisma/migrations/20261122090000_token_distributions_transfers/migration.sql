-- Additive. Holdings received by transfer have no investment behind them,
-- so investment_id becomes nullable (relaxing a constraint, no data change).
ALTER TABLE "token_allocations" ALTER COLUMN "investment_id" DROP NOT NULL;
ALTER TABLE "token_allocations" ADD COLUMN IF NOT EXISTS "source" VARCHAR(20) NOT NULL DEFAULT 'investment';
ALTER TABLE "token_allocations" ADD COLUMN IF NOT EXISTS "from_allocation_id" UUID;

CREATE TABLE IF NOT EXISTS "token_transfers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_token_id" UUID NOT NULL,
  "from_allocation_id" UUID NOT NULL,
  "to_allocation_id" UUID,
  "from_user_id" UUID NOT NULL,
  "to_user_id" UUID NOT NULL,
  "units" BIGINT NOT NULL,
  "mode" VARCHAR(10) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'sending',
  "from_address" VARCHAR(64),
  "to_address" VARCHAR(64),
  "tx_id" VARCHAR(64),
  "last_valid" BIGINT,
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "token_transfers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "token_transfers_from_user_id_idx" ON "token_transfers"("from_user_id");
CREATE INDEX IF NOT EXISTS "token_transfers_to_user_id_idx" ON "token_transfers"("to_user_id");
CREATE INDEX IF NOT EXISTS "token_transfers_status_idx" ON "token_transfers"("status");
-- One in-flight on-chain transfer per source holding.
CREATE UNIQUE INDEX IF NOT EXISTS "token_transfers_one_sending" ON "token_transfers"("from_allocation_id") WHERE "status" = 'sending';

CREATE TABLE IF NOT EXISTS "token_distributions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "project_token_id" UUID NOT NULL,
  "kind" VARCHAR(20) NOT NULL DEFAULT 'profit',
  "amount" DECIMAL(30,8) NOT NULL,
  "fee" DECIMAL(30,8) NOT NULL DEFAULT 0,
  "status" VARCHAR(20) NOT NULL DEFAULT 'requested',
  "description" VARCHAR(500),
  "requested_by" UUID NOT NULL,
  "reviewed_by" UUID,
  "notes" TEXT,
  "total_units" BIGINT,
  "paid_amount" DECIMAL(30,8),
  "holders" INTEGER,
  "snapshot_at" TIMESTAMPTZ(6),
  "debit_transaction_id" UUID,
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "token_distributions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "token_distributions_project_id_idx" ON "token_distributions"("project_id");
CREATE INDEX IF NOT EXISTS "token_distributions_status_idx" ON "token_distributions"("status");

CREATE TABLE IF NOT EXISTS "token_distribution_payouts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "distribution_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "units" BIGINT NOT NULL,
  "amount" DECIMAL(30,8) NOT NULL,
  "transaction_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "token_distribution_payouts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "token_distribution_payouts_distribution_id_fkey" FOREIGN KEY ("distribution_id") REFERENCES "token_distributions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "token_distribution_payouts_distribution_id_user_id_key" ON "token_distribution_payouts"("distribution_id", "user_id");
CREATE INDEX IF NOT EXISTS "token_distribution_payouts_user_id_idx" ON "token_distribution_payouts"("user_id");
