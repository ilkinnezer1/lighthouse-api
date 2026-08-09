import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  Validate,
} from 'class-validator';
import {
  IsCronExpression,
  IsTimezone,
} from '../../scheduled-tasks/dto/create-scheduled-task.dto';

// The target is immutable: repointing a schedule at another database would leave
// its retention counting backups it never took.
export class UpdateBackupScheduleDto {
  @IsOptional()
  @IsString()
  @Validate(IsCronExpression)
  schedule?: string;

  @IsOptional()
  @IsString()
  @Validate(IsTimezone)
  timezone?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  keepLast?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
