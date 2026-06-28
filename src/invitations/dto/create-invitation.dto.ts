import { Transform } from 'class-transformer';
import { OrgRole } from '@prisma/client';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
} from 'class-validator';

const lower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

// One invitation, in one of two modes (validated in the service): an in-app
// invite of an existing user (`username` or `email`), or a shareable link
// (`link: true`, with `email` as optional metadata). `role` is always required.
export class CreateInvitationDto {
  @IsEnum(OrgRole)
  role!: OrgRole;

  @IsOptional()
  @Transform(lower)
  @IsString()
  username?: string;

  @IsOptional()
  @Transform(lower)
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsBoolean()
  link?: boolean;
}
