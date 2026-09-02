/** Connection-pool and statement tuning for the Prisma/pg adapter. */

/** Per-replica connection ceiling. Size the database's `max_connections` as
 *  `POOL_MAX × replicas` plus headroom for migrations and psql. */
export const POOL_MAX = 20;

/** Fail fast instead of queueing forever when the pool is saturated. */
export const POOL_CONNECTION_TIMEOUT_MS = 5_000;

export const POOL_IDLE_TIMEOUT_MS = 30_000;

/** Server-side backstop: no single statement holds a connection past this. */
export const STATEMENT_TIMEOUT_MS = 30_000;
