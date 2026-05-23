-- CreateIndex
CREATE UNIQUE INDEX "managed_databases_environment_id_name_key" ON "managed_databases"("environment_id", "name");
