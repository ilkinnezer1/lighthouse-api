export interface LogEntry {
  id: string;
  line: string;
  stage: string | null;
}

export type LogEmitter = (entry: LogEntry) => void;

// Redis Stream entry fields arrive as a flat ['k1','v1','k2','v2'] array.
// The Go worker XADDs `line` and `stage`.
export function toLogEntry(id: string, fields: string[]): LogEntry {
  const map: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) {
    map[fields[i]] = fields[i + 1];
  }
  return { id, line: map.line ?? '', stage: map.stage ?? null };
}
