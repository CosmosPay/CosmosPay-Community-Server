import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AdminAuditService } from './admin-audit.service';

/**
 * Records admin **reads**, not just writes.
 *
 * `AdminService`'s mutations each commit an audit row inside the same
 * `$transaction` as the change — the right pattern, and it stays. The gap was
 * the other direction: every cross-tenant read (`GET /v1/admin/receivers`
 * returns every tenant's KYC records, `GET /v1/admin/payins` their funding
 * details) was completely untraced. A leaked `role: "read"` credential could
 * therefore enumerate the whole platform and leave nothing behind, which fails
 * both non-repudiation and the "who accessed my data" question a subject-access
 * request asks.
 *
 * This is an interceptor rather than a per-method call so that a route added
 * later is audited by default. It deliberately records only that a read
 * happened and with what filters — never the response body, which is exactly
 * the personal data we do not want duplicated into a second table.
 *
 * The write is fire-and-forget: an audit failure must not fail the read, and a
 * mutation's audit row is written transactionally elsewhere, so nothing depends
 * on this one landing.
 */
@Injectable()
export class AdminReadAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AdminAuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.method !== 'GET') {
      // Mutations are audited inside their own transaction, with the resource
      // id and before/after detail this interceptor cannot see.
      return next.handle();
    }

    const principal = request.adminPrincipal;
    if (!principal) return next.handle();

    const route = request.route as { path?: string } | undefined;
    const resourceId = route?.path ?? request.path;

    return next.handle().pipe(
      tap({
        next: () => {
          void this.audit
            .record({
              actor: principal,
              action: 'admin.read',
              resourceType: 'admin_read',
              resourceId,
              metadata: {
                // Query filters only — never the rows that came back.
                query: sanitizeQuery(request.query),
                ip: request.ip ?? null,
              },
            })
            .catch(() => {
              /* never fail a read because the audit write failed */
            });
        },
      }),
    );
  }
}

/**
 * Query parameters are operator-supplied filters (`network`, `status`, `take`),
 * so they are safe and useful to keep — but coerce to strings and cap the size
 * so a hostile or accidental giant query string cannot bloat the audit table.
 */
function sanitizeQuery(query: unknown): Record<string, string> {
  if (!query || typeof query !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (Object.keys(out).length >= 12) break;
    const flat = Array.isArray(value) ? value.join(',') : String(value);
    out[key.slice(0, 40)] = flat.slice(0, 120);
  }
  return out;
}
