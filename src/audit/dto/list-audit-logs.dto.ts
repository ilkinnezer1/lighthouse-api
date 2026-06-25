import { Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class ListAuditLogsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsNumberString()
  cursor?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  resourceType?: string;

  @IsOptional()
  @IsUUID()
  resourceId?: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}
