-- CreateEnum
CREATE TYPE "ChecklistItemSource" AS ENUM ('SEEDED', 'MANUAL');

-- CreateEnum
CREATE TYPE "CheckResult" AS ENUM ('PASS', 'FAIL');

-- CreateTable
CREATE TABLE "checklist_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "environment_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "source" "ChecklistItemSource" NOT NULL DEFAULT 'MANUAL',
    "issue_key" TEXT,
    "issue_url" TEXT,
    "seed_key" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checklist_checks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "item_id" UUID NOT NULL,
    "deployment_id" UUID NOT NULL,
    "result" "CheckResult" NOT NULL,
    "note" TEXT,
    "checked_by_user_id" UUID,
    "finding_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checklist_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Partial: only seeded rows. Seeding the same range twice must not duplicate,
-- but a manual item has no seed key and Postgres would collapse every one of
-- them into a single allowed NULL pair under a plain unique index.
CREATE UNIQUE INDEX "checklist_items_environment_id_seed_key_key" ON "checklist_items"("environment_id", "seed_key")
  WHERE "seed_key" IS NOT NULL;

-- CreateIndex
CREATE INDEX "checklist_items_environment_id_created_at_idx" ON "checklist_items"("environment_id", "created_at");

-- CreateIndex
-- An item's state on a given build is one fact; re-checking upserts onto it.
CREATE UNIQUE INDEX "checklist_checks_item_id_deployment_id_key" ON "checklist_checks"("item_id", "deployment_id");

-- CreateIndex
CREATE INDEX "checklist_checks_deployment_id_idx" ON "checklist_checks"("deployment_id");

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_items" ADD CONSTRAINT "checklist_items_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_checks" ADD CONSTRAINT "checklist_checks_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "checklist_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_checks" ADD CONSTRAINT "checklist_checks_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_checks" ADD CONSTRAINT "checklist_checks_checked_by_user_id_fkey" FOREIGN KEY ("checked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "checklist_checks" ADD CONSTRAINT "checklist_checks_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
