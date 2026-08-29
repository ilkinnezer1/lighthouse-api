import { Type } from 'class-transformer';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CheckResult } from '@prisma/client';

/**
 * The bug a FAIL files. Same fields as CreateFindingDto because it *is* one —
 * the service hands this straight to FindingsService.create rather than writing
 * a finding of its own, so log capture, audit and the inbox all happen once, in
 * the place that already does them.
 */
export class CheckFindingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  body?: string;
}

export class CheckItemDto {
  @IsEnum(CheckResult)
  result!: CheckResult;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;

  // Optional even on a FAIL: "tried it, broken, no time to write it up" is a
  // real state, and demanding a bug report is how a checklist stops being used.
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CheckFindingDto)
  finding?: CheckFindingDto;
}
