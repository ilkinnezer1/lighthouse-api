/**
 * Build the public URL a deployment will be reachable on.
 *
 * Pattern: `<env>.<project>.<username>.<base-domain>` — except when the
 * environment has a `customDomain` set (Phase 3 schema field, UI gated by
 * a feature flag), in which case the custom domain wins outright.
 *
 * Pure function: takes only the bag it needs, no DI. The caller pulls
 * `mode` and `baseDomain` from `ConfigService` and feeds them in.
 */
export interface DeployUrlParts {
  mode: 'local' | 'server';
  baseDomain: string;
  username: string;
  projectSubdomain: string;
  envSubdomain: string;
  customDomain?: string | null;
}

export function buildDeployUrl(parts: DeployUrlParts): string {
  const protocol = parts.mode === 'server' ? 'https' : 'http';
  const host = parts.customDomain
    ? parts.customDomain
    : `${parts.envSubdomain}.${parts.projectSubdomain}.${parts.username}.${parts.baseDomain}`;
  return `${protocol}://${host}`;
}
