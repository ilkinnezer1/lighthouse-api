-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "OrgInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "is_personal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "OrgRole" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "role" "OrgRole" NOT NULL,
    "invited_by_user_id" UUID NOT NULL,
    "invitee_user_id" UUID,
    "token_hash" TEXT,
    "email" TEXT,
    "status" "OrgInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "org_memberships_org_id_user_id_key" ON "org_memberships"("org_id", "user_id");

-- CreateIndex
CREATE INDEX "org_memberships_user_id_idx" ON "org_memberships"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "org_invitations_token_hash_key" ON "org_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "org_invitations_org_id_idx" ON "org_invitations"("org_id");

-- CreateIndex
CREATE INDEX "org_invitations_invitee_user_id_idx" ON "org_invitations"("invitee_user_id");

-- A user cannot hold two PENDING in-app invites to the same org (partial unique;
-- not expressible in the Prisma schema).
CREATE UNIQUE INDEX "org_invitations_pending_invitee_key" ON "org_invitations"("org_id", "invitee_user_id") WHERE "status" = 'PENDING' AND "invitee_user_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_memberships" ADD CONSTRAINT "org_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_invitee_user_id_fkey" FOREIGN KEY ("invitee_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Project re-anchoring (org tenancy) ──────────────────────────────────────
-- Add the new columns nullable so the backfill can populate them before the
-- NOT NULL + FK constraints land.
ALTER TABLE "projects" ADD COLUMN "organization_id" UUID;
ALTER TABLE "projects" ADD COLUMN "created_by_user_id" UUID;

-- Attribution is exactly the old owner.
UPDATE "projects" SET "created_by_user_id" = "owner_id";

-- Backfill 1: one personal org per existing user (name = display name or
-- username; slug = username, which is globally unique so the slug is too).
INSERT INTO "organizations" ("id", "name", "slug", "is_personal", "created_at", "updated_at")
SELECT gen_random_uuid(),
       COALESCE("display_name", "username"::text),
       "username"::text,
       true,
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
FROM "users";

-- Backfill 2: the user is OWNER of their personal org (join on slug = username).
INSERT INTO "org_memberships" ("id", "org_id", "user_id", "role", "created_at")
SELECT gen_random_uuid(), o."id", u."id", 'OWNER', CURRENT_TIMESTAMP
FROM "users" u
JOIN "organizations" o ON o."is_personal" = true AND o."slug" = u."username"::text;

-- Backfill 3: every project lands in its owner's personal org.
UPDATE "projects" p
SET "organization_id" = o."id"
FROM "users" u
JOIN "organizations" o ON o."is_personal" = true AND o."slug" = u."username"::text
WHERE p."owner_id" = u."id";

-- Enforce the new shape now that data is populated.
ALTER TABLE "projects" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "projects" ALTER COLUMN "created_by_user_id" SET NOT NULL;

-- Retire ownerId: drop its FK and per-owner namespace indexes, then the column.
ALTER TABLE "projects" DROP CONSTRAINT "projects_owner_id_fkey";
DROP INDEX "projects_owner_id_idx";
DROP INDEX "projects_owner_id_slug_key";
DROP INDEX "projects_owner_id_subdomain_key";
ALTER TABLE "projects" DROP COLUMN "owner_id";

-- Re-create the per-user namespace uniqueness against the creator + new anchors.
CREATE INDEX "projects_organization_id_idx" ON "projects"("organization_id");
CREATE INDEX "projects_created_by_user_id_idx" ON "projects"("created_by_user_id");
CREATE UNIQUE INDEX "projects_created_by_user_id_slug_key" ON "projects"("created_by_user_id", "slug");
CREATE UNIQUE INDEX "projects_created_by_user_id_subdomain_key" ON "projects"("created_by_user_id", "subdomain");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
