import type { MaintenanceAction } from '../projects/dto/build-config.schema';

// Built-in maintenance actions keyed by the framework the worker detected for a
// deployment. Merged with the project's hand-written actions by id (project
// wins) in maintenanceActionsFor. Action ids are stable across frameworks so a
// project can override "migrate" once regardless of stack.
export const FRAMEWORK_PRESETS: Record<string, MaintenanceAction[]> = {
  laravel: [
    {
      id: 'migrate',
      label: 'Run migrations',
      service: 'php',
      command: 'php artisan migrate --force',
      destructive: true,
    },
    {
      id: 'migrate-status',
      label: 'Migration status',
      service: 'php',
      command: 'php artisan migrate:status',
    },
    {
      id: 'cache-clear',
      label: 'Clear caches',
      service: 'php',
      command: 'php artisan optimize:clear',
    },
    {
      id: 'queue-restart',
      label: 'Restart queue',
      service: 'php',
      command: 'php artisan queue:restart',
    },
  ],
  symfony: [
    {
      id: 'migrate',
      label: 'Run migrations',
      service: 'php',
      command: 'php bin/console doctrine:migrations:migrate --no-interaction',
      destructive: true,
    },
    {
      id: 'migrate-status',
      label: 'Migration status',
      service: 'php',
      command: 'php bin/console doctrine:migrations:status',
    },
    {
      id: 'cache-clear',
      label: 'Clear caches',
      service: 'php',
      command: 'php bin/console cache:clear',
    },
  ],
  'node-prisma': [
    {
      id: 'migrate',
      label: 'Run migrations',
      service: 'web',
      command: 'npx prisma migrate deploy',
      destructive: true,
    },
    {
      id: 'migrate-status',
      label: 'Migration status',
      service: 'web',
      command: 'npx prisma migrate status',
    },
    {
      id: 'db-seed',
      label: 'Seed database',
      service: 'web',
      command: 'npx prisma db seed',
    },
  ],
  rails: [
    {
      id: 'migrate',
      label: 'Run migrations',
      service: 'web',
      command: 'bin/rails db:migrate',
      destructive: true,
    },
    {
      id: 'migrate-status',
      label: 'Migration status',
      service: 'web',
      command: 'bin/rails db:migrate:status',
    },
  ],
  django: [
    {
      id: 'migrate',
      label: 'Run migrations',
      service: 'web',
      command: 'python manage.py migrate',
      destructive: true,
    },
    {
      id: 'migrate-status',
      label: 'Show migrations',
      service: 'web',
      command: 'python manage.py showmigrations',
    },
  ],
};
