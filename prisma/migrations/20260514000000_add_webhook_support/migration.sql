-- AlterTable
ALTER TABLE "projects"
  ADD COLUMN "provider_repo_full_name" TEXT,
  ADD COLUMN "webhook_secret_enc" TEXT;

-- AlterTable
ALTER TABLE "environments"
  ADD COLUMN "pr_number" INTEGER;

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "project_id" UUID,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projects_provider_repo_full_name_idx" ON "projects"("provider_repo_full_name");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_provider_delivery_id_key" ON "webhook_deliveries"("provider", "delivery_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_project_id_idx" ON "webhook_deliveries"("project_id");
