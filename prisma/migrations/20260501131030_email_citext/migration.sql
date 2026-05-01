-- Enable case-insensitive text type for email comparisons
CREATE EXTENSION IF NOT EXISTS citext;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "email" SET DATA TYPE CITEXT;
