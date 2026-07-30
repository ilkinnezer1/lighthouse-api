import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateSnapshotDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @IsOptional()
  @IsBoolean()
  isBaseline?: boolean;
}
