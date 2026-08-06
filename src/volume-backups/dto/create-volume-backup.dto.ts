import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateVolumeBackupDto {
  // Must match a name declared in the project's buildConfig.volumes.
  @IsString()
  @MinLength(1)
  @MaxLength(63)
  volumeName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}
