-- The P2P direct flow (native plugin `eldorado`): a payment request paid from the
-- payer's page through the marketplace's API. `processingSessionId` names the direct
-- order's session that made the request `processing`, so a cancellation of THAT order
-- opens it again. Nullable, nothing is rewritten.
ALTER TABLE "p2p_payment_request" ADD COLUMN     "processingSessionId" TEXT;
