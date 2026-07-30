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
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { TaskOverlapPolicy } from '@prisma/client';
import { CronExpressionParser } from 'cron-parser';

@ValidatorConstraint({ name: 'IsCronExpression', async: false })
export class IsCronExpression implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    try {
      CronExpressionParser.parse(value, { tz: 'UTC' });
      return true;
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return 'schedule must be a valid 5-field cron expression, e.g. "0 3 * * *"';
  }
}

@ValidatorConstraint({ name: 'IsTimezone', async: false })
export class IsTimezone implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return 'timezone must be a valid IANA zone, e.g. "Europe/London"';
  }
}

export class CreateScheduledTaskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  service!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  command!: string;

  @IsString()
  @Validate(IsCronExpression)
  schedule!: string;

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
  @Max(21_600) // 6h — a longer job belongs in its own container, not an exec
  timeoutSec?: number;

  @IsOptional()
  @IsEnum(TaskOverlapPolicy)
  overlap?: TaskOverlapPolicy;
}
