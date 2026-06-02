import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { DeploymentStatus } from '@prisma/client';

export class ListDeploymentsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @IsEnum(DeploymentStatus)
  status?: DeploymentStatus;

  @IsOptional()
  @IsUUID()
  projectId?: string;
}
