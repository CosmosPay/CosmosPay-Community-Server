-- Companion to `20260901120000_audit_hardening`: the purely additive indexes,
-- built CONCURRENTLY so the deploy does not block writes.
--
-- These are separated from that migration for a mechanical reason, not a
-- stylistic one: it opens an explicit transaction to make its de-duplicating
-- DELETE atomic with the UNIQUE index that depends on it, and PostgreSQL
-- refuses CREATE INDEX CONCURRENTLY inside a transaction block (SQLSTATE
-- 25001). One file cannot have both.
--
-- Every statement is IF NOT EXISTS, so a failed build is recovered by dropping
-- the invalid index and re-running rather than by editing production DDL. A
-- CONCURRENTLY build that fails leaves the index behind marked INVALID — and
-- IF NOT EXISTS considers an invalid index present, so it must be dropped:
--   SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
--   WHERE NOT i.indisvalid;
-- CI applies both migrations against a real PostgreSQL and asserts that set is
-- empty.
--
-- Why each index exists: every list endpoint filters by consumer and orders by
-- createdAt desc against single-column indexes only; the observers sweep by
-- status oldest-first; and inbound BlindPay webhooks look rows up by provider
-- id alone, which the (consumerId, blindpayId) composites cannot serve because
-- blindpayId is their second column.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "request_log_internal_createdAt_idx" ON "request_log"("internal", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "payment_intent_consumerId_createdAt_idx" ON "payment_intent"("consumerId", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "payment_intent_status_createdAt_idx"     ON "payment_intent"("status", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "swap_consumerId_createdAt_idx" ON "swap"("consumerId", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "swap_status_createdAt_idx"     ON "swap"("status", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_delivery_endpointId_createdAt_idx" ON "webhook_delivery"("endpointId", "createdAt");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "payin_blindpayId_idx"             ON "payin"("blindpayId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "payout_blindpayId_idx"            ON "payout"("blindpayId");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "blindpay_receiver_blindpayId_idx" ON "blindpay_receiver"("blindpayId");
