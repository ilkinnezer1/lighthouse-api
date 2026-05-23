-- CreateEnum
CREATE TYPE "DatabaseType" AS ENUM ('POSTGRES', 'MYSQL', 'REDIS', 'MONGO');

-- CreateEnum
CREATE TYPE "DatabaseStatus" AS ENUM ('PROVISIONING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "SnapshotStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "managed_databases" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "environment_id" UUID NOT NULL,
    "type" "DatabaseType" NOT NULL,
    "version" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DatabaseStatus" NOT NULL DEFAULT 'PROVISIONING',
    "host" TEXT,
    "port" INTEGER,
    "conn_secret_enc" TEXT,
    "error_summary" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "managed_databases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "database_id" UUID NOT NULL,
    "status" "SnapshotStatus" NOT NULL DEFAULT 'PENDING',
    "storage_key" TEXT,
    "size_bytes" BIGINT,
    "error_summary" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "database_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "managed_databases_environment_id_idx" ON "managed_databases"("environment_id");

-- CreateIndex
CREATE INDEX "database_snapshots_database_id_created_at_idx" ON "database_snapshots"("database_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "managed_databases" ADD CONSTRAINT "managed_databases_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_snapshots" ADD CONSTRAINT "database_snapshots_database_id_fkey" FOREIGN KEY ("database_id") REFERENCES "managed_databases"("id") ON DELETE CASCADE ON UPDATE CASCADE;
