import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SUBDOMAIN_RE } from '../../projects/util/subdomain';

export class InstantiateTemplateDto {
  // Defaults to the template's own name.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  // Target org. Absent → the caller's personal org, same as creating a project.
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsString()
  @Matches(SUBDOMAIN_RE, {
    message:
      'subdomain must be 3–32 chars, start with a letter, end alphanumeric, contain only [a-z0-9-]',
  })
  subdomain?: string;

  // Values for the template's prompted fields only. Generated fields are
  // server-side and are rejected here.
  @IsOptional()
  @IsObject()
  env?: Record<string, string>;

  // Queue the first deployment immediately. Defaults to true — one click is the
  // point of the feature.
  @IsOptional()
  @IsBoolean()
  deploy?: boolean;
}
