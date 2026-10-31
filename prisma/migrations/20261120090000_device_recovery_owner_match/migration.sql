-- Additive only: device-recovery owner match + manual review.
ALTER TABLE "device_recoveries" ADD COLUMN IF NOT EXISTS "review_reason" VARCHAR(500);
ALTER TABLE "device_recoveries" ADD COLUMN IF NOT EXISTS "face_match_score" DOUBLE PRECISION;
ALTER TABLE "device_recoveries" ADD COLUMN IF NOT EXISTS "reviewed_by" UUID;
ALTER TABLE "device_recoveries" ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMP(6);
CREATE INDEX IF NOT EXISTS "device_recoveries_status_created_at_idx" ON "device_recoveries"("status", "created_at");

CREATE TABLE IF NOT EXISTS "kyc_identity_references" (
  "user_id" UUID NOT NULL,
  "didit_session_id" VARCHAR(128) NOT NULL,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "kyc_identity_references_pkey" PRIMARY KEY ("user_id")
);
