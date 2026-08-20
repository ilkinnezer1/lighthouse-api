import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * One sentence from QA. Everything else — build, SHA, branch set, tickets,
 * environment, logs — is attached by the server, which is the point: the
 * evidence should not depend on whoever is filing remembering to paste it.
 */
export class CreateFindingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  body?: string;
}
