import { DeploymentStatus } from '@prisma/client';

// Worker bumps `last_heartbeat_at` every 30s. 3 min = 6 missed bumps —
// past transient blips, under the worst-case schema comment of 5 min.
export const HEARTBEAT_THRESHOLD_MS = 3 * 60 * 1000;

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
