-- Project-funded escrows. Refunds return the remaining principal to locked project funds.
ALTER TABLE "escrow_contracts" ADD COLUMN IF NOT EXISTS "project_id" UUID;
CREATE INDEX IF NOT EXISTS "idx_escrow_contracts_project" ON "escrow_contracts" ("project_id");

ALTER TABLE "project_spends" ADD COLUMN IF NOT EXISTS "refunded_amount" DECIMAL(30, 8) NOT NULL DEFAULT 0;
ALTER TABLE "project_spends" ADD COLUMN IF NOT EXISTS "refunded_at" TIMESTAMPTZ(6);

DO $$ BEGIN
  ALTER TABLE "escrow_contracts"
    ADD CONSTRAINT "escrow_contracts_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "investment_projects"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
