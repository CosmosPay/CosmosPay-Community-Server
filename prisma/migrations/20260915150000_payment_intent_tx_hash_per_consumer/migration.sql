-- payment_intent."txHash": unique per consumer instead of across every tenant.
--
-- PATCH /v1/payment-intents/:id records a reported txHash without verifying it,
-- and this index made the hash unique across the whole table. A tenant could
-- write another tenant's transaction hash onto an intent of its own; the other
-- tenant's settlement then failed on the index — validate answered 500, the
-- observer retried on every tick, and the intent expired although it was paid.
--
-- Within one consumer the index still means what it should: one transaction
-- settles at most one intent. A transaction carries one memo and the memo is
-- itself unique per consumer, so no two of a consumer's intents can both be
-- verified against the same hash.
--
-- Nothing to backfill: rows unique by "txHash" alone are unique by
-- ("consumerId", "txHash"). Both statements run in the migration's
-- transaction, so there is no moment with neither index; the build holds a
-- write lock on payment_intent while it runs.

-- DropIndex
DROP INDEX "payment_intent_txHash_key";

-- CreateIndex
CREATE UNIQUE INDEX "payment_intent_consumerId_txHash_key" ON "payment_intent"("consumerId", "txHash");
