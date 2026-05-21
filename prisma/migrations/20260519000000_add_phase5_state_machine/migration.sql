-- AlterEnum
ALTER TYPE "DeploymentStageStatus" ADD VALUE 'ROLLED_BACK';

-- AlterTable
ALTER TABLE "deployments"
  ADD COLUMN "cancel_requested_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "deployment_stages"
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 1;
