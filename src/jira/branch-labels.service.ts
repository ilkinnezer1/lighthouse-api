import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  issueKeyFromBranch,
  issueKeysFromBranches,
  issueUrl,
} from './issue-key';
import { JiraApiService } from './jira-api.service';

export interface BranchIssue {
  issueKey: string;
  issueTitle: string | null;
  issueUrl: string | null;
}

/**
 * Labels branch names with the Jira issue they refer to.
 *
 * The pairing is deliberate: the token is the caller's (OAuth 3LO is personal),
 * the site is the org's, so everyone on a project resolves against one Jira
 * while each only ever sees issues their own account may read. A caller who has
 * not connected Atlassian, or an org with no site chosen, gets an empty map and
 * the UI falls back to plain branch names.
 */
@Injectable()
export class BranchLabelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jira: JiraApiService,
  ) {}

  /** Map of branch name → issue, for the branches that name one. */
  async labelBranches(
    userId: string,
    organizationId: string,
    branchNames: string[],
  ): Promise<Map<string, BranchIssue>> {
    const labels = new Map<string, BranchIssue>();
    const keys = issueKeysFromBranches(branchNames);
    if (keys.length === 0) {
      return labels;
    }

    const site = await this.siteFor(organizationId);
    if (!site) {
      return labels;
    }
    const summaries = await this.jira.fetchSummaries(
      userId,
      site.cloudId,
      keys,
    );

    for (const name of branchNames) {
      const key = issueKeyFromBranch(name);
      if (!key) continue;
      // Only a key Jira actually answered for counts as a ticket. The key
      // pattern necessarily also matches ordinary names like `branch-1` and
      // `release-2`; labelling those would replace a real branch name with an
      // invented ticket. Jira's answer is the arbiter, so an unrecognized key
      // leaves the branch exactly as it was.
      const title = summaries.get(key);
      if (!title) continue;
      labels.set(name, {
        issueKey: key,
        issueTitle: title,
        issueUrl: issueUrl(site.url, key),
      });
    }
    return labels;
  }

  /** The org's chosen Jira site, or null when none is configured. */
  async siteFor(
    organizationId: string,
  ): Promise<{ cloudId: string; url: string } | null> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { atlassianCloudId: true, atlassianSiteUrl: true },
    });
    if (!org?.atlassianCloudId || !org.atlassianSiteUrl) {
      return null;
    }
    return { cloudId: org.atlassianCloudId, url: org.atlassianSiteUrl };
  }
}
