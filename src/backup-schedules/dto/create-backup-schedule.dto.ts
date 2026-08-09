import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
} from 'class-validator';
import { BackupTargetKind } from '@prisma/client';
import {
  IsCronExpression,
  IsTimezone,
} from '../../scheduled-tasks/dto/create-scheduled-task.dto';

export class CreateBackupScheduleDto {
  @IsEnum(BackupTargetKind)
  kind!: BackupTargetKind;

  // Required for kind=DATABASE; rejected for kind=VOLUME (checked in the service,
  // which can also verify the target belongs to this environment).
  @IsOptional()
  @IsUUID()
  databaseId?: string;

  // Required for kind=VOLUME.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  volumeName?: string;

  @IsString()
  @Validate(IsCronExpression)
  schedule!: string;

  @IsOptional()
  @IsString()
  @Validate(IsTimezone)
  timezone?: string;

  // 0 disables pruning entirely — an explicit "keep everything" rather than a
  // silent one.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  keepLast?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
