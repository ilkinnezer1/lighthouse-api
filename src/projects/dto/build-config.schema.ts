import { z } from 'zod';

// A curated, one-click maintenance command surfaced on the deployment page.
// The client only ever sees id/label/service/destructive — `command` is the
// server-side allowlist entry and never leaves the API.
export const MaintenanceActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  service: z.string().min(1),
  command: z.string().min(1),
  destructive: z.boolean().optional(),
});

export type MaintenanceAction = z.infer<typeof MaintenanceActionSchema>;

// Lenient reader for the actions array alone, so surfacing the catalog does not
// depend on the rest of buildConfig passing strict validation.
export const MaintenanceActionsSchema = z.array(MaintenanceActionSchema);

const composePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/'), 'composePath must be relative')
  .refine(
    (p) => !p.split('/').includes('..'),
    'composePath must not contain a ".." segment',
  );

export const SetupStepSchema = z
  .object({
    command: z.string().min(1),
    image: z.string().min(1).optional(),
    docker: z.boolean().optional(),
  })
  .strict();

export type SetupStep = z.infer<typeof SetupStepSchema>;

export const BuildConfigSchema = z
  .object({
    strategy: z.enum(['dockerfile', 'compose', 'sandbox-yml']).optional(),
    web: z.string().min(1).optional(),
    cmd: z.array(z.string()).optional(),
    envs: z.record(z.string(), z.string()).optional(),
    // Mode 5: argv the worker runs against a freshly provisioned managed DB
    // once it's healthy (e.g. ["npx", "prisma", "migrate", "deploy"]).
    dbMigrate: z.array(z.string().min(1)).min(1).optional(),
    maintenanceActions: MaintenanceActionsSchema.optional(),
    composePath: composePathSchema.optional(),
    setupSteps: z.array(SetupStepSchema).optional(),
  })
  .strict();

export type BuildConfig = z.infer<typeof BuildConfigSchema>;
