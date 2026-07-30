-- AlterTable
ALTER TABLE "database_snapshots" ADD COLUMN     "is_baseline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "label" TEXT;

-- CreateIndex
CREATE INDEX "database_snapshots_database_id_is_baseline_idx" ON "database_snapshots"("database_id", "is_baseline");
