import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { AUDIT_KEY, type AuditMetadata } from './audit.decorator';
import { AuditService } from './audit.service';

const SENSITIVE_KEY_RE = /password|secret|token|hash/i;

// A handler may attach extra audit detail that isn't derivable from params/body/
// response (e.g. a project transfer's source org, gone after the update). Merged
// into afterJson under `context`.
declare module 'express' {
  interface Request {
    auditContext?: Record<string, unknown>;
  }
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditMetadata | undefined>(
      AUDIT_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!meta) {
      return next.handle();
    }

    const req = ctx.switchToHttp().getRequest<Request>();
    const params = (req.params ?? {}) as Record<string, unknown>;
    const body = (req.body ?? {}) as Record<string, unknown>;

    const base = {
      actorUserId: req.user?.id ?? null,
      action: meta.action,
      resourceType: meta.action.split('.')[0] ?? null,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    };

    return next.handle().pipe(
      tap((response: unknown) => {
        void this.audit.write({
          ...base,
          resourceId: this.extractResourceId(params, response),
          afterJson: this.sanitize({
            params,
            body,
            response,
            context: req.auditContext,
          }),
        });
      }),
      catchError((err: unknown) => {
        void this.audit.write({
          ...base,
          resourceId: this.extractResourceId(params, null),
          afterJson: this.sanitize({
            params,
            body,
            error: this.serializeError(err),
            context: req.auditContext,
          }),
        });
        return throwError(() => err);
      }),
    );
  }

  private extractResourceId(
    params: Record<string, unknown>,
    response: unknown,
  ): string | null {
    if (response && typeof response === 'object' && 'id' in response) {
      const id = response.id;
      if (typeof id === 'string') return id;
    }
    if (typeof params.id === 'string') return params.id;
    return null;
  }

  private sanitize(input: unknown): Prisma.InputJsonValue {
    return JSON.parse(
      JSON.stringify(input, (key, value: unknown) => {
        if (typeof key === 'string' && SENSITIVE_KEY_RE.test(key)) {
          return '[REDACTED]';
        }
        return value;
      }),
    ) as Prisma.InputJsonValue;
  }

  private serializeError(err: unknown): Record<string, unknown> {
    if (err instanceof HttpException) {
      return { name: err.name, message: err.message, status: err.getStatus() };
    }
    if (err instanceof Error) {
      return { name: err.name, message: err.message };
    }
    return { message: String(err) };
  }
}
