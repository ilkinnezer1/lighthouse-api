import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateGitCredentialDto {
  // Bounds only. The token's real validation is GitHub answering to it, and a
  // format regex here would reject the next shape GitHub invents.
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}
