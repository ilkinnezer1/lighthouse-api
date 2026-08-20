-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "context" JSONB,
    "dedupe_key" TEXT NOT NULL,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- "My recent": the feed's only ordering, newest first.
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);

-- CreateIndex
-- Partial: only unread rows; the badge count's hot query is WHERE read_at IS NULL.
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id")
  WHERE "read_at" IS NULL;

-- CreateIndex
-- Dedupe: a redelivered outbox event finds the row already there and stops.
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
