-- payment_settlement: one on-chain transaction settles at most one payment
-- intent, across every tenant.
--
-- payment_intent's ("consumerId", "txHash") index only says it per consumer.
-- The destination is not bound to the consumer, the memo is the caller's to
-- choose, and every anonymous caller under the shared public key is one
-- consumer, so a second tenant could copy an intent's destination, amount and
-- memo and the payer's one transaction settled both. The service now claims the
-- hash here in the same transaction as the SUCCEEDED status change; the primary
-- key admits one claim per (chain, network, txHash), and the loser rolls back.
--
-- The per-consumer index stays: PATCH records a reported hash unverified, and
-- that is the uniqueness it guards. Only a verified settlement writes here.

-- CreateTable
CREATE TABLE "payment_settlement" (
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "intentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_settlement_pkey" PRIMARY KEY ("chain","network","txHash")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_settlement_intentId_key" ON "payment_settlement"("intentId");

-- SET NULL: a deleted intent must not hand its payment back to be claimed again.
-- AddForeignKey
ALTER TABLE "payment_settlement" ADD CONSTRAINT "payment_settlement_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: every intent already settled claims its hash, so a payment that
-- settled before this release cannot settle another intent after it. Where one
-- hash already settled several intents, the earliest settlement keeps the claim;
-- the others stay SUCCEEDED (a terminal status is not rewritten) and are worth
-- reviewing by hand:
--
--   SELECT "chain", "network", "txHash", count(*) FROM "payment_intent"
--   WHERE "status" = 'SUCCEEDED' AND "txHash" IS NOT NULL
--   GROUP BY 1, 2, 3 HAVING count(*) > 1;
INSERT INTO "payment_settlement" ("chain", "network", "txHash", "intentId", "createdAt")
SELECT DISTINCT ON ("chain", "network", "txHash")
       "chain", "network", "txHash", "id", "updatedAt"
FROM "payment_intent"
WHERE "status" = 'SUCCEEDED' AND "txHash" IS NOT NULL
ORDER BY "chain", "network", "txHash", "updatedAt", "id";
