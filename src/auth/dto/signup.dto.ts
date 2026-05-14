import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const normalizeUsername = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

// DNS-label rules: lowercase alnum + hyphens, no leading/trailing hyphen.
// 3–32 chars (32 keeps total subdomain length under DNS's 63-octet limit
// once env + project segments are prepended).
const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;

export class SignupDto {
  @Transform(normalizeEmail)
  @IsEmail()
  email!: string;

  @Transform(normalizeUsername)
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(USERNAME_PATTERN, {
    message:
      'Username must be 3–32 chars, lowercase a–z, 0–9, hyphens, and cannot start or end with a hyphen',
  })
  username!: string;

  @IsString()
  @MinLength(12, { message: 'Password must be at least 12 characters' })
  @MaxLength(128)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayName?: string;
}
