-- Receipts and the payer's email, hardened after review: the email of a
-- payment with the link's own wallet link is bound to the client that gave it
-- (an HMAC, as deposits key a client), and every receipt is reserved against a
-- per-recipient and a per-merchant daily limit before it is sent. Additive:
-- nullable columns and two indexes, nothing rewritten.

-- AlterTable
ALTER TABLE "payment_intent" ADD COLUMN     "payerClientKey" TEXT,
ADD COLUMN     "receiptTo" TEXT,
ADD COLUMN     "receiptToAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "payment_intent_receiptTo_receiptToAt_idx" ON "payment_intent"("receiptTo", "receiptToAt");

-- CreateIndex
CREATE INDEX "payment_intent_consumerId_receiptToAt_idx" ON "payment_intent"("consumerId", "receiptToAt");
