// How a template env value is produced when the user isn't asked for it. The
// generated ones exist so an app that needs a real secret gets one that was
// never typed, pasted, or shown in a browser.
export type TemplateEnvGenerator =
  | 'secret32' // 32 random bytes, base64 — app-level encryption keys
  | 'hex32' // 32 random bytes, hex — tokens that must be url-safe
  | 'password' // 24-char alphanumeric — admin logins the user will read back
  | 'uuid'
  | 'domain' // the deploy host, no protocol
  | 'url'; // the full deploy URL, with protocol

export interface TemplateEnvField {
  key: string;
  label: string;
  description?: string;
  // Server-produced; never prompted and never accepted from the request.
  generate?: TemplateEnvGenerator;
  default?: string;
  // Prompted fields only: instantiate fails when one is missing.
  required?: boolean;
  // Prompted fields only: the web masks the input.
  secret?: boolean;
}

export interface TemplateVolume {
  name: string;
  path: string;
}

export interface TemplateSpec {
  slug: string;
  name: string;
  description: string;
  category: string;
  website?: string;
  // The upstream project's repository. Metadata for the gallery only — strategy
  // 'image' returns early from the worker's clone stage, so this is never
  // fetched. It exists because Project.repoUrl is non-nullable.
  repoUrl: string;
  image: string;
  port: number;
  volumes?: TemplateVolume[];
  env?: TemplateEnvField[];
  cpuLimit?: number;
  memoryMb?: number;
  // Shown after instantiate — first-login steps, default credentials, caveats.
  postInstall?: string;
}

// What the gallery renders: the spec minus nothing, but with generated env
// fields collapsed to a count so the UI can say "3 secrets generated for you".
export interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  category: string;
  website?: string;
  image: string;
  port: number;
  volumeCount: number;
  promptedEnv: TemplateEnvField[];
  generatedEnvCount: number;
  postInstall?: string;
}
