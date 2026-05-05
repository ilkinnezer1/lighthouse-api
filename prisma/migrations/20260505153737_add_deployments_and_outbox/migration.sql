-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('QUEUED', 'CLONING', 'BUILDING', 'PUSHING', 'STARTING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DeploymentStageStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "deployments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "environment_id" UUID NOT NULL,
    "triggered_by_user_id" UUID,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'QUEUED',
    "commit_sha" TEXT,
    "commit_message" TEXT,
    "commit_author" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "last_heartbeat_at" TIMESTAMPTZ(3),
    "error_summary" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_stages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deployment_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DeploymentStageStatus" NOT NULL DEFAULT 'PENDING',
    "ordinal" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "error_json" JSONB,

    CONSTRAINT "deployment_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deployment_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "image" TEXT,
    "container_id" TEXT,
    "host" TEXT,
    "port" INTEGER,
    "is_web" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_outbox" (
    "id" BIGSERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "user_id" UUID,
    "payload" JSONB NOT NULL,
    "drained_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deployments_environment_id_created_at_idx" ON "deployments"("environment_id", "created_at" DESC);

-- CreateIndex
-- Partial: only in-flight statuses; lets the Phase-5 reaper scan a tiny set forever.
CREATE INDEX "deployments_status_idx"
  ON "deployments"("status")
  WHERE "status" IN ('QUEUED','CLONING','BUILDING','PUSHING','STARTING');

-- CreateIndex
CREATE INDEX "deployment_stages_deployment_id_idx" ON "deployment_stages"("deployment_id");

-- CreateIndex
CREATE UNIQUE INDEX "deployment_stages_deployment_id_ordinal_key" ON "deployment_stages"("deployment_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "services_deployment_id_name_key" ON "services"("deployment_id", "name");

-- CreateIndex
-- Partial: only undrained rows; the drainer's hot query is WHERE drained_at IS NULL.
CREATE INDEX "event_outbox_drained_at_idx"
  ON "event_outbox"("drained_at")
  WHERE "drained_at" IS NULL;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_triggered_by_user_id_fkey" FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployment_stages" ADD CONSTRAINT "deployment_stages_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_outbox" ADD CONSTRAINT "event_outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
