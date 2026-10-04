import { Injectable } from '@nestjs/common';
import type { Prisma } from '@generated/prisma/client';
import type { AdminPrincipal } from '@/admin/admin-auth';
import { adminSkip, adminTake } from '@/admin/admin-list';
import { toAuditEntry } from '@/audit/audit-writer';
import { PrismaService } from '@/prisma/prisma.service';

export interface RecordAdminAuditInput {
  actor: AdminPrincipal;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Append-only platform-admin audit trail (issue #34).
 * There is intentionally no delete/update API — rows are immutable history.
 * Mutations write their row with `recordAuditInTransaction` (`@/audit/audit-writer`)
 * inside the same `$transaction` as the change, so the two cannot diverge; this
 * service is the read side plus the standalone insert for reads.
 */
@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Standalone insert (mutations use `recordAuditInTransaction` instead). */
  async record(input: RecordAdminAuditInput) {
    return this.prisma.adminAuditLog.create({
      data: toAuditEntry(
        input.actor,
        input.action,
        input.resourceType,
        input.resourceId,
        input.metadata,
      ),
    });
  }

  async list(opts: { take?: number; skip?: number } = {}) {
    const take = adminTake(opts.take);
    const skip = adminSkip(opts.skip);
    const [data, total] = await Promise.all([
      this.prisma.adminAuditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.adminAuditLog.count(),
    ]);
    return { data, total, take, skip };
  }
}
