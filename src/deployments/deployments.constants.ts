export const DEFAULT_STAGES = [
  'clone',
  'apply_files',
  'setup',
  'build',
  'provision_network',
  'provision_database',
  'run',
  'health_check',
  'swap_traefik',
  'retire_old_deployment',
] as const;

export type StageName = (typeof DEFAULT_STAGES)[number];
