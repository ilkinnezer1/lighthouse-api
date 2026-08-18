import { Type } from 'class-transformer';
import {
  IsBooleanString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { EnvironmentType } from '@prisma/client';

export class ListEnvironmentsDto {
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
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsEnum(EnvironmentType)
  type?: EnvironmentType;

  @IsOptional()
  @IsBooleanString()
  active?: string;

  // Active org to scope to; defaults to the caller's personal org when absent.
  @IsOptional()
  @IsUUID()
  orgId?: string;
}
