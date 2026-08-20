import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Deploying into a locked environment is warn-and-override, not a hard block:
 * a hard block gets worked around by deploying somewhere else, and then the
 * lock stops being a signal at all. The audit entry is what keeps it honest.
 */
export class DeployOverrideDto {
  @IsOptional()
  @IsBoolean()
  overrideLock?: boolean;
}
