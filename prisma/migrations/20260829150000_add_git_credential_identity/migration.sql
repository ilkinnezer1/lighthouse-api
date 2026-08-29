-- AlterTable
ALTER TABLE "git_credentials" ADD COLUMN     "login" TEXT,
ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
