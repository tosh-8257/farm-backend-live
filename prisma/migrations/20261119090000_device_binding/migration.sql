-- Device binding (additive only).
ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "trusted_device_id" UUID;
CREATE INDEX IF NOT EXISTS "user_sessions_trusted_device_id_idx" ON "user_sessions"("trusted_device_id");
ALTER TABLE "pending_login_verifications" ADD COLUMN IF NOT EXISTS "trusted_device_id" UUID;

CREATE TABLE IF NOT EXISTS "trusted_devices" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "device_id" VARCHAR(128) NOT NULL,
  "public_key" TEXT NOT NULL,
  "key_alg" VARCHAR(16) NOT NULL,
  "platform" VARCHAR(20),
  "name" VARCHAR(100),
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "approved_at" TIMESTAMP(6),
  "approved_by_device_id" UUID,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(6),
  "revoked_at" TIMESTAMP(6),
  CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "trusted_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "trusted_devices_user_id_device_id_key" ON "trusted_devices"("user_id", "device_id");
CREATE INDEX IF NOT EXISTS "trusted_devices_user_id_status_idx" ON "trusted_devices"("user_id", "status");

CREATE TABLE IF NOT EXISTS "device_login_challenges" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "device_id" VARCHAR(128) NOT NULL,
  "nonce" VARCHAR(128) NOT NULL,
  "ip_address" VARCHAR(100),
  "expires_at" TIMESTAMP(6) NOT NULL,
  "used_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_login_challenges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "device_login_challenges_device_id_created_at_idx" ON "device_login_challenges"("device_id", "created_at");
CREATE INDEX IF NOT EXISTS "device_login_challenges_expires_at_idx" ON "device_login_challenges"("expires_at");

CREATE TABLE IF NOT EXISTS "device_recoveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "trusted_device_id" UUID NOT NULL,
  "otp_hash" TEXT NOT NULL,
  "otp_attempts" INTEGER NOT NULL DEFAULT 0,
  "status" VARCHAR(20) NOT NULL DEFAULT 'otp_sent',
  "didit_session_id" VARCHAR(128),
  "didit_status" VARCHAR(40),
  "expires_at" TIMESTAMP(6) NOT NULL,
  "completed_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_recoveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "device_recoveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "device_recoveries_user_id_status_idx" ON "device_recoveries"("user_id", "status");
