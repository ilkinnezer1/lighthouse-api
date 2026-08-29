-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "allow_member_git_credentials" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "git_credentials" ADD COLUMN     "organization_id" UUID;
ALTER TABLE "git_credentials" ALTER COLUMN "user_id" DROP NOT NULL;

-- DropForeignKey
-- user_id was ON DELETE CASCADE, which would delete an organization's shared
-- credential along with the admin who added it. Attribution must not own it.
ALTER TABLE "git_credentials" DROP CONSTRAINT "git_credentials_user_id_fkey";

-- AddForeignKey
ALTER TABLE "git_credentials" ADD CONSTRAINT "git_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "git_credentials" ADD CONSTRAINT "git_credentials_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "git_credentials_organization_id_idx" ON "git_credentials"("organization_id");

-- A credential must belong to somebody: an organization, or the person who
-- added it. Nullable user_id (above) makes the orphan case representable, and
-- this is what stops it existing.
ALTER TABLE "git_credentials" ADD CONSTRAINT "git_credentials_owner_present"
  CHECK ("organization_id" IS NOT NULL OR "user_id" IS NOT NULL);

-- `ON DELETE SET NULL` above and the CHECK together would make deleting a user
-- who owns a PERSONAL credential impossible: nulling user_id on a row with no
-- organization leaves it belonging to nobody, and the CHECK rejects it — so the
-- DELETE fails outright. The two requirements only coexist if personal rows are
-- gone before the FK action runs.
--
-- A personal credential has no other owner, so it SHOULD die with its user;
-- only organization rows are meant to survive with user_id nulled. Postgres
-- cannot express "cascade for some rows, set null for others" in one FK, so
-- this does it as a BEFORE DELETE trigger.
CREATE OR REPLACE FUNCTION delete_personal_git_credentials() RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM git_credentials
  WHERE user_id = OLD.id AND organization_id IS NULL;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_delete_personal_git_credentials
  BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION delete_personal_git_credentials();
