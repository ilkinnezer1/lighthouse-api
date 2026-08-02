/**
 * Build the public URL a deployment will be reachable on.
 *
 * Pattern: `<env>.<project>.<identity>.<base-domain>` — where `identity` is the
 * project's organization slug. The worker routes deploys on this same org slug,
 * so the two MUST agree; a personal org's slug is the owner's username, so solo
 * deploy URLs are unchanged. When the environment has a `customDomain` set
 * (Phase 3 schema field, UI gated by a feature flag), the custom domain wins
 * outright.
 *
 * Pure function: takes only the bag it needs, no DI. The caller pulls
 * `mode` and `baseDomain` from `ConfigService` and feeds them in.
 */
export interface DeployUrlParts {
  mode: 'local' | 'server';
  baseDomain: string;
  identity: string;
  projectSubdomain: string;
  envSubdomain: string;
  customDomain?: string | null;
}

export function buildDeployUrl(parts: DeployUrlParts): string {
  const protocol = parts.mode === 'server' ? 'https' : 'http';
  const host = parts.customDomain
    ? parts.customDomain
    : `${parts.envSubdomain}.${parts.projectSubdomain}.${parts.identity}.${parts.baseDomain}`;
  return `${protocol}://${host}`;
}
