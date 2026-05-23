-- AlterTable
ALTER TABLE "managed_databases" ADD COLUMN     "run_migrate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "seed_from_database_id" UUID,
ADD COLUMN     "seed_from_snapshot_id" UUID;

-- AddForeignKey
ALTER TABLE "managed_databases" ADD CONSTRAINT "managed_databases_seed_from_database_id_fkey" FOREIGN KEY ("seed_from_database_id") REFERENCES "managed_databases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "managed_databases" ADD CONSTRAINT "managed_databases_seed_from_snapshot_id_fkey" FOREIGN KEY ("seed_from_snapshot_id") REFERENCES "database_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
