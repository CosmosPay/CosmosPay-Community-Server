-- Charges in local money shown as a QR (native plugin `eldorado`): the
-- `p2p_payment_request` table, and on `p2p_ramp_session` the request a purchase
-- was opened from plus what the marketplace's webhook reports about its order.
--
-- A new table and nullable columns only; nothing existing is rewritten.
-- AlterTable
ALTER TABLE "p2p_ramp_session" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "deliveredAmount" TEXT,
ADD COLUMN     "paymentRequestId" TEXT,
ADD COLUMN     "providerOrderId" TEXT,
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "txHash" TEXT;

-- CreateTable
CREATE TABLE "p2p_payment_request" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "sharedPublicKey" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "token" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "description" TEXT,
    "estimatedAmountOut" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "paidAmount" TEXT,
    "paidTxHash" TEXT,
    "paidSessionId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_payment_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "p2p_payment_request_consumerId_network_createdAt_idx" ON "p2p_payment_request"("consumerId", "network", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_ramp_session_paymentRequestId_idx" ON "p2p_ramp_session"("paymentRequestId");

-- AddForeignKey
ALTER TABLE "p2p_ramp_session" ADD CONSTRAINT "p2p_ramp_session_paymentRequestId_fkey" FOREIGN KEY ("paymentRequestId") REFERENCES "p2p_payment_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_payment_request" ADD CONSTRAINT "p2p_payment_request_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
