-- CreateEnum
CREATE TYPE "TaskOverlapPolicy" AS ENUM ('SKIP', 'QUEUE');

-- CreateEnum
CREATE TYPE "TaskRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TaskRunTrigger" AS ENUM ('SCHEDULE', 'MANUAL');

-- CreateTable
CREATE TABLE "scheduled_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "environment_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "timeout_sec" INTEGER NOT NULL DEFAULT 900,
    "overlap" "TaskOverlapPolicy" NOT NULL DEFAULT 'SKIP',
    "last_run_at" TIMESTAMPTZ(3),
    "next_run_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scheduled_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "deployment_id" UUID,
    "status" "TaskRunStatus" NOT NULL,
    "trigger" "TaskRunTrigger" NOT NULL DEFAULT 'SCHEDULE',
    "exit_code" INTEGER,
    "output" TEXT,
    "error_summary" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "task_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduled_tasks_enabled_next_run_at_idx" ON "scheduled_tasks"("enabled", "next_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_tasks_environment_id_name_key" ON "scheduled_tasks"("environment_id", "name");

-- CreateIndex
CREATE INDEX "task_runs_task_id_started_at_idx" ON "task_runs"("task_id", "started_at" DESC);

-- AddForeignKey
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_runs" ADD CONSTRAINT "task_runs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "scheduled_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
