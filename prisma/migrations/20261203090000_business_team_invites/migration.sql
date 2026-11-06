-- Team invites. Membership is created only when the invitee accepts.
CREATE TABLE IF NOT EXISTS "business_invites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "role" "business_member_role" NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "invited_by" UUID,
    "user_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "business_invites_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_business_invites_business" ON "business_invites"("business_id", "status");
CREATE INDEX IF NOT EXISTS "idx_business_invites_phone" ON "business_invites"("phone", "status");
CREATE INDEX IF NOT EXISTS "idx_business_invites_user" ON "business_invites"("user_id");

DO $$ BEGIN
  ALTER TABLE "business_invites"
    ADD CONSTRAINT "business_invites_business_id_fkey"
    FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "business_invites"
    ADD CONSTRAINT "business_invites_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
