import {
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_LOCK_HOURS, MIN_LOCK_HOURS } from '../environment-lock';

export class LockEnvironmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsNumber()
  @Min(MIN_LOCK_HOURS)
  @Max(MAX_LOCK_HOURS)
  hours?: number;
}
