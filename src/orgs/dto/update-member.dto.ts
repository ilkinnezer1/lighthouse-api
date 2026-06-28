import { OrgRole } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateMemberDto {
  @IsEnum(OrgRole)
  role!: OrgRole;
}
