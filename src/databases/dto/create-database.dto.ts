import { DatabaseType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export type CreateDatabaseMode =
  | 'attach-existing'
  | 'create-empty'
  | 'copy'
  | 'create-from-snapshot';

// Modes that name a brand-new managed DB (everything except attach-existing,
// which inherits the source's name).
const NAMED_MODES: CreateDatabaseMode[] = [
  'create-empty',
  'copy',
  'create-from-snapshot',
];

/**
 * Discriminated on `mode`. class-validator can't express a real union, so each
 * branch's fields are gated with @ValidateIf — only the active mode's fields
 * are validated. The global ValidationPipe (whitelist + forbidNonWhitelisted)
 * still requires every field to be decorated, so all branches live here and
 * the service reads only the fields relevant to the chosen mode.
 *
 *   { mode: 'attach-existing',      databaseId }                  // reuse a connection
 *   { mode: 'create-empty',         type, version, name, runMigrate? }
 *   { mode: 'copy',                 sourceDatabaseId, name }      // pg_dump|pg_restore from a live DB
 *   { mode: 'create-from-snapshot', snapshotId, name }            // pg_restore from a MinIO blob
 *
 * For `copy` / `create-from-snapshot` the engine type+version are derived from
 * the source (you can't copy across engines), so they aren't accepted here.
 */
export class CreateDatabaseDto {
  @IsIn(['attach-existing', 'create-empty', 'copy', 'create-from-snapshot'])
  mode!: CreateDatabaseMode;

  // ---- mode: attach-existing ----
  // Source managed DB whose live connection this new env-owned row will reuse.
  @ValidateIf((o: CreateDatabaseDto) => o.mode === 'attach-existing')
  @IsUUID()
  databaseId?: string;

  // ---- mode: copy ----
  // Source managed DB to clone via pg_dump | pg_restore into a new container.
  @ValidateIf((o: CreateDatabaseDto) => o.mode === 'copy')
  @IsUUID()
  sourceDatabaseId?: string;

  // ---- mode: create-from-snapshot ----
  // Snapshot whose MinIO blob seeds a new container (may belong to another env).
  @ValidateIf((o: CreateDatabaseDto) => o.mode === 'create-from-snapshot')
  @IsUUID()
  snapshotId?: string;

  // ---- mode: create-empty ----
  @ValidateIf((o: CreateDatabaseDto) => o.mode === 'create-empty')
  @IsEnum(DatabaseType)
  type?: DatabaseType;

  @ValidateIf((o: CreateDatabaseDto) => o.mode === 'create-empty')
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  version?: string;

  // Mode 5: run project.buildConfig.dbMigrate after the empty DB is healthy.
  @ValidateIf((o: CreateDatabaseDto) => o.mode === 'create-empty')
  @IsOptional()
  @IsBoolean()
  runMigrate?: boolean;

  // Required for every create-* mode; attach-existing inherits the source name.
  @ValidateIf((o: CreateDatabaseDto) => NAMED_MODES.includes(o.mode))
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name?: string;
}
