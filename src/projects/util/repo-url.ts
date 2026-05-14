const GITHUB_RE = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?\/?$/i;

export function parseGithubFullName(repoUrl: string): string | null {
  const m = repoUrl.match(GITHUB_RE);
  return m ? `${m[1]}/${m[2]}` : null;
}
