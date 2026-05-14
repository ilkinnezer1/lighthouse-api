export interface GithubRepository {
  full_name: string;
}

export interface GithubPushPayload {
  ref: string;
  repository: GithubRepository;
  head_commit?: {
    id: string;
    message: string;
    author?: { name?: string };
  } | null;
}

export interface GithubPullRequestPayload {
  action: string;
  repository: GithubRepository;
  pull_request: {
    number: number;
    head: { ref: string; sha: string };
  };
}
