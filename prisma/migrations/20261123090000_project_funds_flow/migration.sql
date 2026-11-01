-- Additive only.

ALTER TABLE "investment_projects" ADD COLUMN IF NOT EXISTS "returns_deposited" DECIMAL(30,8) NOT NULL DEFAULT 0;
ALTER TABLE "investment_projects" ADD COLUMN IF NOT EXISTS "returns_distributed" DECIMAL(30,8) NOT NULL DEFAULT 0;
ALTER TABLE "investment_projects" ADD COLUMN IF NOT EXISTS "distribution_mode" VARCHAR(20) NOT NULL DEFAULT 'off';
ALTER TABLE "investment_projects" ADD COLUMN IF NOT EXISTS "distribution_percent" DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE "investment_projects" ADD COLUMN IF NOT EXISTS "distribution_period_end" TIMESTAMPTZ(6);
ALTER TABLE "investment_projects" ADD COLUMN IF NOT EXISTS "income_kind" VARCHAR(20) NOT NULL DEFAULT 'profit';
ALTER TABLE "investment_projects" ADD COLUMN IF NOT EXISTS "funds_paused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "investment_projects" ADD COLUMN IF NOT EXISTS "funds_paused_reason" VARCHAR(300);

ALTER TABLE "token_distributions" ADD COLUMN IF NOT EXISTS "source" VARCHAR(20) NOT NULL DEFAULT 'business_wallet';
ALTER TABLE "token_distributions" ADD COLUMN IF NOT EXISTS "period_key" VARCHAR(60);
CREATE UNIQUE INDEX IF NOT EXISTS "token_distributions_project_period_key" ON "token_distributions"("project_id", "period_key") WHERE "period_key" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "project_returns" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "amount" DECIMAL(30,8) NOT NULL,
  "source" VARCHAR(20) NOT NULL,
  "source_transaction_id" UUID,
  "note" VARCHAR(500),
  "deposited_by" UUID NOT NULL,
  "transaction_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "project_returns_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "project_returns_source_transaction_id_key" ON "project_returns"("source_transaction_id");
CREATE INDEX IF NOT EXISTS "project_returns_project_id_idx" ON "project_returns"("project_id");

CREATE TABLE IF NOT EXISTS "project_escrows" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
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
  CONSTRAINT "project_escrows_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "project_escrows_project_id_key" ON "project_escrows"("project_id");
CREATE UNIQUE INDEX IF NOT EXISTS "project_escrows_address_key" ON "project_escrows"("address");

CREATE TABLE IF NOT EXISTS "project_spends" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "target_kind" VARCHAR(20) NOT NULL,
  "target_id" UUID NOT NULL,
  "recipient_business_id" UUID NOT NULL,
  "recipient_user_id" UUID NOT NULL,
  "amount" DECIMAL(30,8) NOT NULL,
  "tag" VARCHAR(120),
  "note" VARCHAR(500),
  "idempotency_key" VARCHAR(120) NOT NULL,
  "transaction_id" UUID,
  "transaction_reference" VARCHAR(100),
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "project_spends_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "project_spends_idempotency_key_key" ON "project_spends"("idempotency_key");
CREATE INDEX IF NOT EXISTS "project_spends_project_id_created_at_idx" ON "project_spends"("project_id", "created_at");

CREATE TABLE IF NOT EXISTS "project_chain_moves" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "kind" VARCHAR(20) NOT NULL,
  "ref_id" UUID,
  "from_address" VARCHAR(64) NOT NULL,
  "to_address" VARCHAR(64) NOT NULL,
  "units" BIGINT NOT NULL,
  "move_key" VARCHAR(160) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "tx_id" VARCHAR(64),
  "last_valid" BIGINT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "project_chain_moves_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "project_chain_moves_move_key_key" ON "project_chain_moves"("move_key");
CREATE INDEX IF NOT EXISTS "project_chain_moves_status_created_at_idx" ON "project_chain_moves"("status", "created_at");
CREATE INDEX IF NOT EXISTS "project_chain_moves_project_id_idx" ON "project_chain_moves"("project_id");

CREATE TABLE IF NOT EXISTS "project_funds_audit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID,
  "action" VARCHAR(40) NOT NULL,
  "actor" VARCHAR(64),
  "amount" DECIMAL(30,8),
  "detail" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "project_funds_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "project_funds_audit_project_id_created_at_idx" ON "project_funds_audit"("project_id", "created_at");
CREATE INDEX IF NOT EXISTS "project_funds_audit_action_created_at_idx" ON "project_funds_audit"("action", "created_at");
