-- AlterEnum
ALTER TYPE "WebhookEventType" ADD VALUE 'SWAP_CREATED';
ALTER TYPE "WebhookEventType" ADD VALUE 'SWAP_SUBMITTED';
ALTER TYPE "WebhookEventType" ADD VALUE 'SWAP_SUCCEEDED';
ALTER TYPE "WebhookEventType" ADD VALUE 'SWAP_FAILED';

-- CreateEnum
CREATE TYPE "SwapStatus" AS ENUM ('PENDING', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "swap" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "sendAsset" TEXT NOT NULL DEFAULT 'native',
    "sendAssetIssuer" TEXT,
    "sendAmount" TEXT NOT NULL,
    "feeAmount" TEXT NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "swapAmount" TEXT NOT NULL,
    "destAsset" TEXT NOT NULL DEFAULT 'native',
    "destAssetIssuer" TEXT,
    "destEstimated" TEXT NOT NULL,
    "destMin" TEXT NOT NULL,
    "slippageBps" INTEGER NOT NULL,
    "path" JSONB NOT NULL,
    "memo" TEXT,
    "status" "SwapStatus" NOT NULL DEFAULT 'PENDING',
    "xdr" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "swap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "swap_consumerId_idx" ON "swap"("consumerId");

-- CreateIndex
CREATE INDEX "swap_status_idx" ON "swap"("status");

-- CreateIndex
CREATE INDEX "swap_txHash_idx" ON "swap"("txHash");

-- AddForeignKey
ALTER TABLE "swap" ADD CONSTRAINT "swap_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
