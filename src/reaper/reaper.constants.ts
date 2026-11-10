import { DeploymentStatus } from '@prisma/client';

// Worker bumps `last_heartbeat_at` every 30s. 3 min = 6 missed bumps —
// past transient blips, under the worst-case schema comment of 5 min.
export const HEARTBEAT_THRESHOLD_MS = 3 * 60 * 1000;

// Managed DBs / snapshots have no heartbeat column, so the reaper can only go
// by age: a row still PROVISIONING/PENDING this long after creation means the
// worker never picked it up or died mid-job. Generous on purpose so a
// legitimately long copy/restore (pg_restore of a large DB) isn't killed early
// — a future heartbeat column could tighten this.
export const PROVISION_THRESHOLD_MS = 15 * 60 * 1000;

// An imported dump stays PENDING for as long as the browser takes to upload it,
// which for a multi-GB file on a slow link is far past PROVISION_THRESHOLD_MS.
export const IMPORT_UPLOAD_THRESHOLD_MS = 6 * 60 * 60 * 1000;

// Statuses where the worker is presumed to have picked up the row and
// should be heartbeating. QUEUED is excluded — those haven't been picked
// up yet; SUCCEEDED/FAILED/CANCELLED are terminal.
export const IN_FLIGHT_STATUSES: DeploymentStatus[] = [
  DeploymentStatus.CLONING,
  DeploymentStatus.BUILDING,
  DeploymentStatus.PUSHING,
  DeploymentStatus.STARTING,
  DeploymentStatus.RUNNING,
];
