-- AlterTable
ALTER TABLE "database_snapshots" ADD COLUMN     "automatic" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "volume_backups" ADD COLUMN     "automatic" BOOLEAN NOT NULL DEFAULT false;

