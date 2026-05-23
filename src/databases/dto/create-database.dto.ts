import { DatabaseType } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export type CreateDatabaseMode = 'attach-existing' | 'create-empty';

/**
 * Discriminated on `mode`. class-validator can't express a real union, so each
 * branch's fields are gated with @ValidateIf — only the active mode's fields
 * are validated. The global ValidationPipe (whitelist + forbidNonWhitelisted)
 * still requires every field to be decorated, so both branches live here and
 * the service reads only the fields relevant to the chosen mode.
 *
 *   { mode: 'attach-existing', databaseId }                 // reuse a connection
 *   { mode: 'create-empty',    type, version, name }        // worker provisions
 */
export class CreateDatabaseDto {
  @IsIn(['attach-existing', 'create-empty'])
  mode!: CreateDatabaseMode;

  // ---- mode: attach-existing ----
  // Source managed DB whose live connection this new env-owned row will reuse.
  @ValidateIf((o: CreateDatabaseDto) => o.mode === 'attach-existing')
  @IsUUID()
  databaseId?: string;

  // ---- mode: create-empty ----
  @ValidateIf((o: CreateDatabaseDto) => o.mode === 'create-empty')
  @IsEnum(DatabaseType)
  type?: DatabaseType;

  @ValidateIf((o: CreateDatabaseDto) => o.mode === 'create-empty')
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  version?: string;

  @ValidateIf((o: CreateDatabaseDto) => o.mode === 'create-empty')
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;
}
