-- Additive: record where a USD/KES rate came from and whether it is a manual override.
ALTER TABLE "currency_rates" ADD COLUMN IF NOT EXISTS "source" VARCHAR(32);
ALTER TABLE "currency_rates" ADD COLUMN IF NOT EXISTS "is_override" BOOLEAN NOT NULL DEFAULT false;
