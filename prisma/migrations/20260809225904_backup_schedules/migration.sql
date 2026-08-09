-- CreateEnum
CREATE TYPE "BackupTargetKind" AS ENUM ('DATABASE', 'VOLUME');

-- CreateTable
CREATE TABLE "backup_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "BackupTargetKind" NOT NULL,
    "environment_id" UUID NOT NULL,
    "database_id" UUID,
    "volume_name" TEXT,
    "schedule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "keep_last" INTEGER NOT NULL DEFAULT 7,
    "created_by_id" UUID NOT NULL,
    "last_run_at" TIMESTAMPTZ(3),
    "next_run_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "backup_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "backup_schedules_enabled_next_run_at_idx" ON "backup_schedules"("enabled", "next_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "backup_schedules_database_id_key" ON "backup_schedules"("database_id");

-- CreateIndex
CREATE UNIQUE INDEX "backup_schedules_environment_id_volume_name_key" ON "backup_schedules"("environment_id", "volume_name");

-- AddForeignKey
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_database_id_fkey" FOREIGN KEY ("database_id") REFERENCES "managed_databases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_schedules" ADD CONSTRAINT "backup_schedules_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

