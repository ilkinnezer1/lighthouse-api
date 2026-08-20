import { FindingStatus } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';

export class ListFindingsDto {
  @IsOptional()
  @IsEnum(FindingStatus)
  status?: FindingStatus;
}
