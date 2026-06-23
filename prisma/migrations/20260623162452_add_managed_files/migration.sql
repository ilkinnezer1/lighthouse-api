-- CreateTable
CREATE TABLE "managed_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "environment_id" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "content_enc" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "managed_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "managed_files_environment_id_path_key" ON "managed_files"("environment_id", "path");

-- AddForeignKey
ALTER TABLE "managed_files" ADD CONSTRAINT "managed_files_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
