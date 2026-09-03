-- Audit remediation: LP idempotency, quote ownership, inbound webhook dedup,
-- non-suppressible request logging, and the composite indexes the hot listing
-- and observer queries actually need.
--
-- ---------------------------------------------------------------------------
-- This migration is split in two, and the split is load-bearing.
--
-- A plain CREATE INDEX takes a SHARE lock for the whole build, blocking every
-- INSERT and UPDATE on that table. On `payment_intent`, `swap`,
-- `webhook_delivery` and `request_log` — all of which grow without bound —
-- that is a write outage on deploy proportional to how long the service has
-- been live. Those purely additive indexes therefore need CONCURRENTLY, which
-- PostgreSQL refuses to run inside a transaction block.
--
-- But the de-duplicating DELETE below and the UNIQUE index that depends on it
-- MUST be atomic: during a rolling deploy an old pod (which has no unique index
-- yet) can insert a duplicate between them and fail the index build, leaving
-- this migration half applied. That needs an explicit transaction.
--
-- Both cannot live in one file — verified against PostgreSQL 17, an explicit
-- BEGIN anywhere in the file makes every later CREATE INDEX CONCURRENTLY fail
-- with SQLSTATE 25001. So: correctness work here, under a transaction;
-- concurrent index builds in the companion migration, with none.
--
-- Statements here are written to be re-runnable (IF NOT EXISTS) so recovering
-- from a partial failure is `prisma migrate resolve --rolled-back` plus a
-- re-run rather than hand-edited production DDL. The one exception is the
-- CREATE TYPE, flagged where it appears.
--
-- ---------------------------------------------------------------------------
-- 1. request_log: flag internal traffic instead of dropping the row.
--
-- The interceptor used to return early when `X-Cosmos-Internal` was present, so
-- anyone able to set that header kept their requests out of the audit log
-- entirely. The row is now always written and merely marked; the API-log view
-- filters on this column.
-- ---------------------------------------------------------------------------
ALTER TABLE "request_log" ADD COLUMN IF NOT EXISTS "internal" BOOLEAN NOT NULL DEFAULT false;


-- ---------------------------------------------------------------------------
-- 2. liquidity_pool_operation: back-port the swap hardening (issue #17).
--
-- Swap has carried @@unique([consumerId, idempotencyKey]) and
-- @@unique([network, txHash]) since the double-SWAP_SUCCEEDED fix; the LP module
-- was copied from swaps before that and never received either. Two rows sharing
-- one on-chain transaction produced two LIQUIDITY_SUCCEEDED webhooks for a
-- single deposit.
--
-- Collapse historical duplicates before creating the unique index, using the
-- same precedence the swap migration used: keep the row furthest along the
-- lifecycle, then the earliest. Deleted rows are phantoms that could never both
-- settle (identical XDR / shared account sequence).
-- ---------------------------------------------------------------------------
ALTER TABLE "liquidity_pool_operation" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

-- The de-dup DELETE and the UNIQUE index that depends on it must be one atomic
-- step. Prisma 7 runs these statements outside a transaction, so during a
-- rolling deploy an old pod — which has no unique index yet — could insert a
-- duplicate between them and fail the index build, leaving the migration half
-- applied. BEGIN/COMMIT makes the pair atomic; the SHARE ROW EXCLUSIVE lock
-- blocks writers (not readers) for the few milliseconds it spans.
BEGIN;

LOCK TABLE "liquidity_pool_operation" IN SHARE ROW EXCLUSIVE MODE;

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "network", "txHash"
      ORDER BY
        -- Cost basis outranks everything else. Two rows sharing one hash can
        -- both be SUCCEEDED, with the basis captured on whichever one
        -- `finalizeSucceeded` ran against — which is the row the customer
        -- submitted, not necessarily the earliest by "createdAt". Ordering by
        -- status and age alone would keep the basis-less row and delete the one
        -- holding "sharesReceived", and a deposit with no basis is taxed
        -- nothing on withdraw, forever. This column is money.
        ("sharesReceived" IS NOT NULL) DESC,
        CASE "status"
          WHEN 'SUCCEEDED' THEN 0
          WHEN 'SUBMITTED' THEN 1
          WHEN 'PENDING' THEN 2
          WHEN 'FAILED' THEN 3
          ELSE 4
        END,
        "createdAt" ASC,
        id ASC
    ) AS rn
  FROM "liquidity_pool_operation"
)
DELETE FROM "liquidity_pool_operation"
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Replaced by the unique (network, txHash) index below.
DROP INDEX IF EXISTS "liquidity_pool_operation_txHash_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "liquidity_pool_operation_consumerId_idempotencyKey_key"
  ON "liquidity_pool_operation"("consumerId", "idempotencyKey");

CREATE UNIQUE INDEX IF NOT EXISTS "liquidity_pool_operation_network_txHash_key"
  ON "liquidity_pool_operation"("network", "txHash");

COMMIT;

CREATE INDEX IF NOT EXISTS "liquidity_pool_operation_consumerId_createdAt_idx"
  ON "liquidity_pool_operation"("consumerId", "createdAt");

CREATE INDEX IF NOT EXISTS "liquidity_pool_operation_status_createdAt_idx"
  ON "liquidity_pool_operation"("status", "createdAt");

-- ---------------------------------------------------------------------------
-- 3. blindpay_quote: ownership record for BlindPay quote ids.
--
-- Quote ids are minted on a BlindPay platform instance shared by every tenant,
-- so the id alone proves nothing. Executing a payin/payout forwarded the
-- caller's quote id straight upstream with no ownership check, letting one
-- tenant execute another tenant's quote and have the result mirrored into their
-- own records. Quotes are now recorded at creation and resolved by
-- (consumer, quote id) before the upstream call.
-- ---------------------------------------------------------------------------
-- The one statement in this file that is NOT re-runnable: PostgreSQL has no
-- CREATE TYPE IF NOT EXISTS, and the usual DO-block guard cannot be used here
-- because Prisma splits a migration file on ';' and that breaks dollar-quoting.
-- If a re-run reaches this line and reports 'type already exists', drop it
-- first:
--   DROP TYPE IF EXISTS "BlindpayQuoteKind";
-- Safe while blindpay_quote does not exist, which is the only state a partial
-- failure can leave it in — the table is created immediately below.
CREATE TYPE "BlindpayQuoteKind" AS ENUM ('PAYIN', 'PAYOUT');

CREATE TABLE IF NOT EXISTS "blindpay_quote" (
  "id"         TEXT NOT NULL,
  "consumerId" TEXT NOT NULL,
  "blindpayId" TEXT NOT NULL,
  "kind"       "BlindpayQuoteKind" NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "blindpay_quote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "blindpay_quote_consumerId_blindpayId_key"
  ON "blindpay_quote"("consumerId", "blindpayId");

CREATE INDEX IF NOT EXISTS "blindpay_quote_consumerId_idx" ON "blindpay_quote"("consumerId");

ALTER TABLE "blindpay_quote"
  ADD CONSTRAINT "blindpay_quote_consumerId_fkey"
  FOREIGN KEY ("consumerId") REFERENCES "consumer"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. blindpay_webhook_event: inbound (Svix) delivery de-duplication.
--
-- Svix retries until acknowledged, re-sending the same `svix-id`. Each retry
-- re-applied the update and re-emitted an outbound notification. The unique
-- index is the claim: first delivery in wins, retries are dropped.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "blindpay_webhook_event" (
  "id"        TEXT NOT NULL,
  "svixId"    TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "blindpay_webhook_event_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "blindpay_webhook_event_svixId_key"
  ON "blindpay_webhook_event"("svixId");

CREATE INDEX IF NOT EXISTS "blindpay_webhook_event_createdAt_idx"
  ON "blindpay_webhook_event"("createdAt");

-- ---------------------------------------------------------------------------
-- 5. Indexes for queries that previously scanned.
--
-- Every list endpoint filters by consumer and orders by createdAt desc against
-- single-column indexes only; the observers sweep by status oldest-first; and
-- inbound BlindPay webhooks look rows up by provider id alone, which the
-- (consumerId, blindpayId) composites cannot serve because blindpayId is their
-- second column.
-- ---------------------------------------------------------------------------



