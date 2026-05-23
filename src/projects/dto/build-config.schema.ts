import { z } from 'zod';

export const BuildConfigSchema = z
  .object({
    strategy: z.enum(['dockerfile', 'compose', 'sandbox-yml']).optional(),
    web: z.string().min(1).optional(),
    cmd: z.array(z.string()).optional(),
    envs: z.record(z.string(), z.string()).optional(),
    // Mode 5: argv the worker runs against a freshly provisioned managed DB
    // once it's healthy (e.g. ["npx", "prisma", "migrate", "deploy"]).
    dbMigrate: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export type BuildConfig = z.infer<typeof BuildConfigSchema>;
