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
