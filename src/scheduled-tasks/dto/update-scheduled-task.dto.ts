import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
} from 'class-validator';
import { TaskOverlapPolicy } from '@prisma/client';
import { IsCronExpression, IsTimezone } from './create-scheduled-task.dto';

// Spelled out rather than derived via PartialType so the property types survive
// for the `dto.schedule ?? existing.schedule` merge in the service.
export class UpdateScheduledTaskDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  service?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  command?: string;

  @IsOptional()
  @IsString()
  @Validate(IsCronExpression)
  schedule?: string;

  @IsOptional()
  @IsString()
  @Validate(IsTimezone)
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(21_600)
  timeoutSec?: number;

  @IsOptional()
  @IsEnum(TaskOverlapPolicy)
  overlap?: TaskOverlapPolicy;
}
