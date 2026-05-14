-- Add nullable, backfill from email local-part, then enforce NOT NULL + UNIQUE.
ALTER TABLE "users" ADD COLUMN "username" CITEXT;

UPDATE "users"
SET "username" = lower(split_part("email"::text, '@', 1))
WHERE "username" IS NULL;

ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");