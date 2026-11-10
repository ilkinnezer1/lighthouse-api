import type { DatabaseType } from '@prisma/client';

const IMPORT_EXTENSIONS: Partial<Record<DatabaseType, readonly string[]>> = {
  MYSQL: ['.sql.gz', '.sql'],
  POSTGRES: ['.sql.gz', '.sql', '.dump'],
};

export function importExtensions(type: DatabaseType): readonly string[] {
  return IMPORT_EXTENSIONS[type] ?? [];
}

export function hasImportExtension(
  type: DatabaseType,
  fileName: string,
): boolean {
  const lower = fileName.toLowerCase();
  return importExtensions(type).some(
    (ext) => lower.endsWith(ext) && lower.length > ext.length,
  );
}

/**
 * Decodes the URL-encoded `X-Import-Filename` header into a bare file name, or
 * null when it is missing, malformed, or carries a path.
 */
export function parseImportFileName(raw: string | undefined): string | null {
  if (!raw) return null;
  let name: string;
  try {
    name = decodeURIComponent(raw).trim();
  } catch {
    return null;
  }
  if (!name || name.length > 255) return null;
  if (/[/\\\0]/.test(name) || name === '.' || name === '..') return null;
  return name;
}

/** Strict decimal Content-Length, or null when absent or not a plain integer. */
export function parseContentLength(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}
