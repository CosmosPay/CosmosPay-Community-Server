-- Cross-chain swaps settled by NEAR Intents (1Click).
--
-- A new table and six webhook event types; nothing existing is rewritten. The
-- enum values are appended (ADD VALUE cannot insert), and none is used in this
-- migration, so adding them inside its transaction is safe on PostgreSQL 12+.
-- CreateEnum
CREATE TYPE "CrossChainSwapStatus" AS ENUM ('AWAITING_DEPOSIT', 'DEPOSIT_DETECTED', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCEEDED', 'REFUNDED', 'FAILED', 'EXPIRED');

-- AlterEnum


ALTER TYPE "WebhookEventType" ADD VALUE 'CROSS_CHAIN_SWAP_CREATED';
ALTER TYPE "WebhookEventType" ADD VALUE 'CROSS_CHAIN_SWAP_UPDATED';
ALTER TYPE "WebhookEventType" ADD VALUE 'CROSS_CHAIN_SWAP_SUCCEEDED';
ALTER TYPE "WebhookEventType" ADD VALUE 'CROSS_CHAIN_SWAP_REFUNDED';
ALTER TYPE "WebhookEventType" ADD VALUE 'CROSS_CHAIN_SWAP_FAILED';
ALTER TYPE "WebhookEventType" ADD VALUE 'CROSS_CHAIN_SWAP_EXPIRED';

-- CreateTable
CREATE TABLE "cross_chain_swap" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "status" "CrossChainSwapStatus" NOT NULL DEFAULT 'AWAITING_DEPOSIT',
    "providerStatus" TEXT NOT NULL,
    "originChain" TEXT NOT NULL,
    "originAsset" TEXT NOT NULL,
    "originAssetId" TEXT NOT NULL,
    "originContract" TEXT,
    "originDecimals" INTEGER NOT NULL,
    "destinationChain" TEXT NOT NULL,
    "destinationAsset" TEXT NOT NULL,
    "destinationAssetId" TEXT NOT NULL,
    "destinationContract" TEXT,
    "destinationDecimals" INTEGER NOT NULL,
    "amountIn" TEXT NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "feeAmount" TEXT NOT NULL,
    "amountOutEstimated" TEXT NOT NULL,
    "amountOutMin" TEXT NOT NULL,
    "slippageBps" INTEGER NOT NULL,
    "recipient" TEXT NOT NULL,
    "refundTo" TEXT NOT NULL,
    "depositAddress" TEXT NOT NULL,
    "depositMemo" TEXT,
    "depositUri" TEXT NOT NULL,
    "depositTxHash" TEXT,
    "amountOut" TEXT,
    "refundedAmount" TEXT,
    "originTxHashes" JSONB,
    "destinationTxHashes" JSONB,
    "timeEstimateSeconds" INTEGER NOT NULL,
    "correlationId" TEXT NOT NULL,
    "quoteSignature" TEXT NOT NULL,
    "quote" JSONB NOT NULL,
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cross_chain_swap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cross_chain_swap_consumerId_createdAt_idx" ON "cross_chain_swap"("consumerId", "createdAt");

-- CreateIndex
CREATE INDEX "cross_chain_swap_status_lastCheckedAt_idx" ON "cross_chain_swap"("status", "lastCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "cross_chain_swap_consumerId_idempotencyKey_key" ON "cross_chain_swap"("consumerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "cross_chain_swap_depositAddress_depositMemo_key" ON "cross_chain_swap"("depositAddress", "depositMemo");

-- AddForeignKey
ALTER TABLE "cross_chain_swap" ADD CONSTRAINT "cross_chain_swap_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

