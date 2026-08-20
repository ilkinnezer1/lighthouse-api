import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { DeployOverrideDto } from './deploy-override.dto';

/**
 * Optional branch set for a manual deploy. Omitted entirely → deploy the
 * environment's branch as today (shallow clone, no merge). When present, the
 * worker builds a worktree from `sourceBranch` and merges `mergeBranches` in
 * order; the API resolves each name to a commit SHA and stores the set on the
 * deployment.
 */
export class CreateDeploymentDto extends DeployOverrideDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  sourceBranch?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(255, { each: true })
  mergeBranches?: string[];
}
