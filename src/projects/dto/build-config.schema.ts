import { z } from 'zod';

export const BuildConfigSchema = z
  .object({
    strategy: z.enum(['dockerfile', 'compose', 'sandbox-yml']).optional(),
    web: z.string().min(1).optional(),
    cmd: z.array(z.string()).optional(),
    envs: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export type BuildConfig = z.infer<typeof BuildConfigSchema>;
