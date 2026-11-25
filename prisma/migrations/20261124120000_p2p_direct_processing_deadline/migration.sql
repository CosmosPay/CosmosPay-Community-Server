-- The P2P direct flow (native plugin `eldorado`): until when a direct order whose
-- payer said they transferred may keep its payment request `processing`
-- (`processingUntil`: the order's due time plus a grace period). Past it, with the
-- order neither completed nor cancelled, a sweep opens the request again.
-- Nullable, nothing is rewritten.
-- AlterTable
ALTER TABLE "p2p_payment_request" ADD COLUMN     "processingUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "p2p_payment_request_status_processingUntil_idx" ON "p2p_payment_request"("status", "processingUntil");
