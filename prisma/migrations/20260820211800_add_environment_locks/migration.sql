-- AlterTable
ALTER TABLE "environments" ADD COLUMN     "lock_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "lock_reason" TEXT,
ADD COLUMN     "locked_at" TIMESTAMPTZ(3),
ADD COLUMN     "locked_by_user_id" UUID;

-- CreateIndex
CREATE INDEX "environments_locked_by_user_id_idx" ON "environments"("locked_by_user_id");

-- AddForeignKey
ALTER TABLE "environments" ADD CONSTRAINT "environments_locked_by_user_id_fkey" FOREIGN KEY ("locked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

