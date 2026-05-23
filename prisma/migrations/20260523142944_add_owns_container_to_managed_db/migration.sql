-- AlterTable
ALTER TABLE "managed_databases" ADD COLUMN     "owns_container" BOOLEAN NOT NULL DEFAULT true;
