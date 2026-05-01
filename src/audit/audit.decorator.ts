import { SetMetadata } from '@nestjs/common';

export const AUDIT_KEY = 'audit';

export interface AuditMetadata {
  action: string;
}

export const Audit = (action: string) => SetMetadata(AUDIT_KEY, { action });
