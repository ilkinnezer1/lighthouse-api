-- CreateEnum
CREATE TYPE "FindingStatus" AS ENUM ('OPEN', 'FIXED', 'CANNOT_REPRODUCE');

-- CreateEnum
CREATE TYPE "LogSnapshotStatus" AS ENUM ('CAPTURED', 'UNAVAILABLE');

-- CreateTable
CREATE TABLE "findings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deployment_id" UUID NOT NULL,
    "reported_by_user_id" UUID,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "status" "FindingStatus" NOT NULL DEFAULT 'OPEN',
    "fixed_by_deployment_id" UUID,
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "log_snapshot_status" "LogSnapshotStatus" NOT NULL DEFAULT 'UNAVAILABLE',
    "log_snapshot" TEXT,
    "log_snapshot_truncated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "findings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The per-deployment findings list: newest first, one deployment at a time.
CREATE INDEX "findings_deployment_id_created_at_idx" ON "findings"("deployment_id", "created_at" DESC);

-- CreateIndex
-- Partial: only OPEN rows. The environments board's per-row open count joins
-- findings to deployments and filters on nothing else, and a closed finding is
-- dead weight in that index forever.
CREATE INDEX "findings_deployment_id_status_idx" ON "findings"("deployment_id")
  WHERE "status" = 'OPEN';

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_reported_by_user_id_fkey" FOREIGN KEY ("reported_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_fixed_by_deployment_id_fkey" FOREIGN KEY ("fixed_by_deployment_id") REFERENCES "deployments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "findings" ADD CONSTRAINT "findings_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
