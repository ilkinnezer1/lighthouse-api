import { IsString, MaxLength, MinLength } from 'class-validator';

export class SetDomainDto {
  // Shape is enforced in DomainsService via assertValidDomain, which also knows
  // the platform base domain; this only bounds the input.
  @IsString()
  @MinLength(3)
  @MaxLength(253)
  domain!: string;
}
