import type { AuditAction } from '../audit/audit.decorator';

// Global so every controller sees these without importing a special Request
// type — a handler that refines its own audit entry shouldn't need a cast.
// `user` is augmented separately by the JWT guard that sets it.
declare module 'express' {
  interface Request {
    // A handler may attach extra audit detail that isn't derivable from
    // params/body/response (e.g. a project transfer's source org, gone after
    // the update). Merged into afterJson under `context`.
    auditContext?: Record<string, unknown>;
    // Overrides the handler's @Audit action when one route has two outcomes
    // worth telling apart (e.g. releasing your own lock vs someone else's).
    auditAction?: AuditAction;
  }
}
