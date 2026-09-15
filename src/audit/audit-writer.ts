import type { Prisma } from '@generated/prisma/client';

/**
 * Who performed an audited action. Structural on purpose: `AdminPrincipal` (a
 * platform-console account) satisfies it, and so does the API-key actor the
 * tenant delete path builds by hand.
 *
 * This file used to live under `src/admin/`, which made `kyc` import from
 * `admin` while `admin` injected `ReceiversService` — a cycle between the two
 * modules, held apart only because TypeScript erases type imports. The audit
 * trail is written from inside other modules' transactions, so the writer has
 * to sit below all of them and depend on none: nothing here may import from a
 * feature module.
 */
export interface AuditActor {
  id: string;
  role: string;
}

/** The create payload of one `adminAuditLog` row. */
export type AuditEntry = {
  actorId: string;
  actorRole: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata?: Prisma.InputJsonValue;
};

/** Build the Prisma create payload for an audit row from an actor + action. */
export function toAuditEntry(
  actor: AuditActor,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata?: Prisma.InputJsonValue,
): AuditEntry {
  return {
    actorId: actor.id,
    actorRole: actor.role,
    action,
    resourceType,
    resourceId,
    metadata,
  };
}

/**
 * Insert an audit row using an interactive-transaction client.
 *
 * Takes the transaction rather than a service so the row commits or rolls back
 * with the mutation it describes — an audit entry for a change that did not
 * happen, or a change with no entry, is exactly what the trail exists to rule out.
 */
export function recordAuditInTransaction(
  tx: Prisma.TransactionClient,
  entry: AuditEntry,
) {
  return tx.adminAuditLog.create({ data: entry });
}
