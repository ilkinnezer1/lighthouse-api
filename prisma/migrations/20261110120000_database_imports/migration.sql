-- CreateEnum
CREATE TYPE "SnapshotOrigin" AS ENUM ('DUMP', 'IMPORT');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADING', 'RESTORING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "database_snapshots" ADD COLUMN     "file_name" TEXT,
ADD COLUMN     "import_status" "ImportStatus",
ADD COLUMN     "origin" "SnapshotOrigin" NOT NULL DEFAULT 'DUMP';
