-- CreateEnum
CREATE TYPE "DeploymentBranchRole" AS ENUM ('SOURCE', 'MERGE');

-- CreateTable
CREATE TABLE "deployment_branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deployment_id" UUID NOT NULL,
    "role" "DeploymentBranchRole" NOT NULL,
    "name" TEXT NOT NULL,
    "sha" TEXT,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "deployment_branches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deployment_branches_deployment_id_idx" ON "deployment_branches"("deployment_id");

-- CreateIndex
CREATE UNIQUE INDEX "deployment_branches_deployment_id_ordinal_key" ON "deployment_branches"("deployment_id", "ordinal");

-- AddForeignKey
ALTER TABLE "deployment_branches" ADD CONSTRAINT "deployment_branches_deployment_id_fkey" FOREIGN KEY ("deployment_id") REFERENCES "deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
