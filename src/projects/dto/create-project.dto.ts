import {
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SUBDOMAIN_RE } from '../util/subdomain';

export class CreateProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  repoUrl!: string;

  @IsOptional()
  @IsString()
  @Matches(SUBDOMAIN_RE, {
    message:
      'subdomain must be 3–32 chars, start with a letter, end alphanumeric, contain only [a-z0-9-]',
  })
  subdomain?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  defaultBranch?: string;
}
