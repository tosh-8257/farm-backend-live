-- Additive: Mkulima usage billing (feature flag MKULIMA_BILLING_ENABLED, default off).
ALTER TYPE "transaction_type" ADD VALUE IF NOT EXISTS 'mkulima_usage';

CREATE TABLE IF NOT EXISTS "mkulima_usage" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "conversation_id" UUID,
  "kind" VARCHAR(20) NOT NULL,
  "model" VARCHAR(100) NOT NULL,
  "provider_calls" INTEGER NOT NULL DEFAULT 0,
  "prompt_tokens" INTEGER NOT NULL DEFAULT 0,
  "cached_tokens" INTEGER NOT NULL DEFAULT 0,
  "completion_tokens" INTEGER NOT NULL DEFAULT 0,
  "audio_seconds" DECIMAL(12,3) NOT NULL DEFAULT 0,
  "cost_source" VARCHAR(20) NOT NULL,
  "provider_cost_usd" DECIMAL(20,10) NOT NULL,
  "usd_kes_rate" DECIMAL(20,8) NOT NULL,
  "cost_farm" DECIMAL(30,8) NOT NULL,
  "margin_farm" DECIMAL(30,8) NOT NULL,
  "charge_farm" DECIMAL(30,8) NOT NULL,
  "transaction_ref" VARCHAR(255),
  "status" VARCHAR(20) NOT NULL,
  "shortfall_farm" DECIMAL(30,8) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "mkulima_usage_transaction_ref_idx" ON "mkulima_usage"("transaction_ref");
CREATE INDEX IF NOT EXISTS "mkulima_usage_user_id_created_at_idx" ON "mkulima_usage"("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "mkulima_usage_created_at_idx" ON "mkulima_usage"("created_at");
