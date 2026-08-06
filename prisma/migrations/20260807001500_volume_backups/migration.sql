-- CreateTable
CREATE TABLE "volume_backups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "environment_id" UUID NOT NULL,
    "volume_name" TEXT NOT NULL,
    "status" "SnapshotStatus" NOT NULL DEFAULT 'PENDING',
    "storage_key" TEXT,
    "size_bytes" BIGINT,
    "error_summary" TEXT,
    "label" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    CONSTRAINT "volume_backups_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "volume_backups_environment_id_created_at_idx" ON "volume_backups"("environment_id", "created_at" DESC);
-- AddForeignKey
ALTER TABLE "volume_backups" ADD CONSTRAINT "volume_backups_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
