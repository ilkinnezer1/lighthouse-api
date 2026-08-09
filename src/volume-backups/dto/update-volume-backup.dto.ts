import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateVolumeBackupDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  // Promote this backup to the state "Reset data" returns the volume to.
  @IsOptional()
  @IsBoolean()
  isBaseline?: boolean;
}
