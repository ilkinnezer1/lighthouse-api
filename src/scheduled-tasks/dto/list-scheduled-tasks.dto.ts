import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export class ListScheduledTasksDto {
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  enabled?: boolean;

  // Active org to scope to; defaults to the caller's personal org when absent.
  @IsOptional()
  @IsUUID()
  orgId?: string;
}
