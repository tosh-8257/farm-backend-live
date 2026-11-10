-- Additive. Session checks on every authenticated request look up jwt_id.
-- Without this index that lookup scans user_sessions and notifications,
-- balances, and deposit screens time out under load.
CREATE INDEX IF NOT EXISTS "user_sessions_jwt_id_idx"
  ON "user_sessions" ("jwt_id");
CREATE INDEX IF NOT EXISTS "user_sessions_user_id_created_at_idx"
  ON "user_sessions" ("user_id", "created_at" DESC);

-- Cover stays in banner_image. Gallery is a list of https image URLs.
ALTER TABLE "investment_projects"
  ADD COLUMN IF NOT EXISTS "gallery_images" JSONB NOT NULL DEFAULT '[]';
