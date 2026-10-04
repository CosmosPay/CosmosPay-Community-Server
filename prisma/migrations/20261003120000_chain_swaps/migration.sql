-- Same-chain swaps off Stellar: Solana through Jupiter, Monad through Kuru Flow.
--
-- A new table; nothing existing is rewritten. It reuses the SwapStatus enum and
-- the SWAP_* webhook events, so no enum changes.
-- CreateTable
CREATE TABLE "chain_swap" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "SwapStatus" NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL,
    "sendAsset" TEXT NOT NULL,
    "sendDecimals" INTEGER NOT NULL,
    "sendAmount" TEXT NOT NULL,
    "destAsset" TEXT NOT NULL,
    "destDecimals" INTEGER NOT NULL,
    "destEstimated" TEXT NOT NULL,
    "destMin" TEXT NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "feeAmount" TEXT NOT NULL,
    "slippageBps" INTEGER NOT NULL,
    "path" JSONB NOT NULL,
    "transaction" JSONB NOT NULL,
    "approval" JSONB,
    "txHash" TEXT,
    "quote" JSONB NOT NULL,
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chain_swap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chain_swap_consumerId_chain_createdAt_idx" ON "chain_swap"("consumerId", "chain", "createdAt");

-- CreateIndex
CREATE INDEX "chain_swap_status_lastCheckedAt_idx" ON "chain_swap"("status", "lastCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "chain_swap_consumerId_idempotencyKey_key" ON "chain_swap"("consumerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "chain_swap_chain_txHash_key" ON "chain_swap"("chain", "txHash");

-- AddForeignKey
ALTER TABLE "chain_swap" ADD CONSTRAINT "chain_swap_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

