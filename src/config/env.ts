import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((v) => v === 'true');

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  MASTER_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, {
      message:
        'MASTER_ENCRYPTION_KEY must be a 32-byte base64 string (generate with: openssl rand -base64 32)',
    }),

  JWT_SECRET: z.string().min(32, {
    message:
      'JWT_SECRET must be at least 32 characters (generate with: openssl rand -hex 64)',
  }),

  BOOTSTRAP_ADMIN_EMAIL: z.email(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12, {
    message: 'BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters',
  }),

  ALLOW_PUBLIC_SIGNUP: booleanString.default(true),

  // ---- routing ----
  // `local` → http on *.localhost (no TLS, dev only)
  // `server` → https on *.<BASE_DOMAIN> (Traefik + Let's Encrypt)
  MODE: z.enum(['local', 'server']).default('local'),
  // Apex used to build deploy URLs: <env>.<project>.<username>.<BASE_DOMAIN>.
  // Defaults to `localhost` so local dev needs no extra config.
  BASE_DOMAIN: z.string().min(1).default('localhost'),

  // ---- object storage (MinIO) ----
  // Snapshot blobs live in MinIO. Nest never speaks S3 itself — it only hands
  // these creds to the worker via the queue payload. The `snapshots` bucket is
  // auto-created by the worker on first use.
  MINIO_ENDPOINT: z.url(),
  MINIO_ACCESS_KEY: z.string().min(1),
  MINIO_SECRET_KEY: z.string().min(1),
  MINIO_BUCKET: z.string().min(1).default('snapshots'),

  // ---- worker HTTP ----
  // Base URL of the worker's HTTP server (`HTTP_ADDR`, default :8081). Nest
  // proxies runtime container logs from `GET /deployments/:id/logs`; all other
  // worker comms stay on the Redis queues.
  WORKER_HTTP_URL: z.url().default('http://localhost:8081'),

  // ---- public URLs ----
  // Public origin of this API (used to build the GitHub OAuth callback
  // `${PUBLIC_API_URL}/integrations/github/callback`) and of the SPA (the
  // post-callback redirect target). Localhost defaults so dev needs no config.
  PUBLIC_API_URL: z.url().default('http://localhost:3000'),
  PUBLIC_APP_URL: z.url().default('http://localhost:5173'),

  // ---- github oauth (integrations) ----
  // Credentials of a GitHub OAuth App. Absent → the GitHub integration reports
  // "not configured" and the connect endpoint 503s (never crashes the app).
  GITHUB_OAUTH_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_OAUTH_CLIENT_SECRET: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((e) => `  - ${e.path.join('.') || '(root)'}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return parsed.data;
}
