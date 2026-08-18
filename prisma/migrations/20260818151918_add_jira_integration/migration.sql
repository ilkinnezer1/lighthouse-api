-- AlterTable
ALTER TABLE "deployment_branches" ADD COLUMN     "issue_key" TEXT,
ADD COLUMN     "issue_title" TEXT;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "atlassian_cloud_id" TEXT,
ADD COLUMN     "atlassian_site_url" TEXT;
