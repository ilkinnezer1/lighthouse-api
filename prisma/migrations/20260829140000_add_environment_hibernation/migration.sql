-- AlterTable
ALTER TABLE "environments" ADD COLUMN     "hibernation_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "idle_timeout_minutes" INTEGER NOT NULL DEFAULT 240,
ADD COLUMN     "last_request_count" BIGINT,
ADD COLUMN     "last_activity_at" TIMESTAMPTZ(3),
ADD COLUMN     "hibernated_at" TIMESTAMPTZ(3);
