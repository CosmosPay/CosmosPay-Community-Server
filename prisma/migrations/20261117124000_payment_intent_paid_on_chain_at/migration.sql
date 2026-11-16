-- When the settling transaction closed on-chain (ledger close or block time),
-- as the verifier read it: a checkout session's proof registered at or after it
-- does not count for the receipt. Additive: one nullable column.
-- AlterTable
ALTER TABLE "payment_intent" ADD COLUMN     "paidOnChainAt" TIMESTAMP(3);

