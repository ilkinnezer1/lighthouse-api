import { IsObject, IsOptional, IsString } from 'class-validator';

/**
 * Either form (or both) may be sent; the service merges `vars` with the parsed
 * `dotenv` block and validates key names. Inner record values are validated in
 * the service, not here (class-validator can't reach into a Record).
 */
export class SetEnvVarsDto {
  @IsOptional()
  @IsObject()
  vars?: Record<string, string>;

  @IsOptional()
  @IsString()
  dotenv?: string;
}
