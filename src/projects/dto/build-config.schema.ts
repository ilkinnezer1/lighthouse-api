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

// A named volume that outlives a redeploy. The name is scoped to the
// environment by the worker, so production and preview never share data.
export const VolumeSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/,
        'volume name must be alphanumeric and may contain _ . -',
      ),
    path: z
      .string()
      .min(2)
      .max(255)
      .refine((p) => p.startsWith('/'), 'mount path must be absolute')
      .refine(
        (p) => !p.split('/').includes('..'),
        'mount path must not contain a ".." segment',
      ),
  })
  .strict();

export type Volume = z.infer<typeof VolumeSchema>;

export const BuildConfigSchema = z
  .object({
    strategy: z
      .enum([
        'dockerfile',
        'compose',
        'generated',
        'nixpacks',
        'buildpacks',
        'railpack',
        'image',
      ])
      .optional(),
    // Required by strategy 'image': the registry ref to pull instead of building.
    image: z.string().min(1).max(255).optional(),
    // Port the container listens on, and the port Traefik routes to.
    port: z.number().int().min(1).max(65535).optional(),
    // Per-container limits. cpuLimit is in cores (0.5 = half a core); both are
    // applied to single-container strategies only, not compose.
    cpuLimit: z.number().positive().max(64).optional(),
    memoryMb: z.number().int().min(64).max(131072).optional(),
    volumes: z.array(VolumeSchema).max(20).optional(),
    // Cloud Native Buildpacks builder for strategy 'buildpacks': the presets
    // 'heroku' and 'paketo', or any builder image reference passed through as-is.
    builder: z.string().min(1).max(255).optional(),
    buildpacks: z.array(z.string().min(1).max(255)).max(20).optional(),
    web: z.string().min(1).optional(),
    cmd: z.array(z.string()).optional(),
    envs: z.record(z.string(), z.string()).optional(),
    // Mode 5: argv the worker runs against a freshly provisioned managed DB
    // once it's healthy (e.g. ["npx", "prisma", "migrate", "deploy"]).
    dbMigrate: z.array(z.string().min(1)).min(1).optional(),
    maintenanceActions: MaintenanceActionsSchema.optional(),
    composePath: composePathSchema.optional(),
    setupSteps: z.array(SetupStepSchema).optional(),
    buildCommand: z.string().min(1).max(1000).optional(),
    startCommand: z.string().min(1).max(1000).optional(),
    runtimeVersion: z.string().min(1).max(100).optional(),
    rootDir: z.string().min(1).max(255).optional(),
  })
  .strict();

export type BuildConfig = z.infer<typeof BuildConfigSchema>;
