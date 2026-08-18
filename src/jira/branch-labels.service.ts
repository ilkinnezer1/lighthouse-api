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

  /**
   * Issues named anywhere in the given strings that Jira confirms exist, keyed
   * by issue key. Works on branch names and commit subjects alike.
   *
   * Only a key Jira actually answers for counts as a ticket. The key pattern
   * necessarily also matches ordinary text like `branch-1` or `utf-8`, and
   * labelling those would invent a ticket that isn't there. Jira's answer is
   * the arbiter.
   */
  async confirmedIssues(
    userId: string,
    organizationId: string,
    texts: string[],
  ): Promise<Map<string, BranchIssue>> {
    const found = new Map<string, BranchIssue>();
    const keys = issueKeysFromBranches(texts);
    if (keys.length === 0) {
      return found;
    }

    const site = await this.siteFor(organizationId);
    if (!site) {
      return found;
    }
    const summaries = await this.jira.fetchSummaries(
      userId,
      site.cloudId,
      keys,
    );
    for (const [key, title] of summaries) {
      found.set(key, {
        issueKey: key,
        issueTitle: title,
        issueUrl: issueUrl(site.url, key),
      });
    }
    return found;
  }

  /** Map of branch name → issue, for the branches that name a confirmed one. */
  async labelBranches(
    userId: string,
    organizationId: string,
    branchNames: string[],
  ): Promise<Map<string, BranchIssue>> {
    const byKey = await this.confirmedIssues(
      userId,
      organizationId,
      branchNames,
    );
    const labels = new Map<string, BranchIssue>();
    if (byKey.size === 0) {
      return labels;
    }
    for (const name of branchNames) {
      const key = issueKeyFromBranch(name);
      const issue = key ? byKey.get(key) : undefined;
      if (issue) {
        labels.set(name, issue);
      }
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
