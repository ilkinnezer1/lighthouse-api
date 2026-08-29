import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  MAX_IDLE_TIMEOUT_MINUTES,
  MIN_IDLE_TIMEOUT_MINUTES,
} from '../environment-hibernation';

export class UpdateHibernationDto {
  @IsBoolean()
  enabled!: boolean;

  // Omitted keeps whatever the environment already has, so the toggle can be
  // flipped without the client having to echo the timeout back.
  @IsOptional()
  @IsInt()
  @Min(MIN_IDLE_TIMEOUT_MINUTES)
  @Max(MAX_IDLE_TIMEOUT_MINUTES)
  idleTimeoutMinutes?: number;
}
