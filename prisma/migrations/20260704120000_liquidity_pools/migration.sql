-- AlterEnum
ALTER TYPE "WebhookEventType" ADD VALUE 'LIQUIDITY_CREATED';
ALTER TYPE "WebhookEventType" ADD VALUE 'LIQUIDITY_SUBMITTED';
ALTER TYPE "WebhookEventType" ADD VALUE 'LIQUIDITY_SUCCEEDED';
ALTER TYPE "WebhookEventType" ADD VALUE 'LIQUIDITY_FAILED';

-- CreateEnum
CREATE TYPE "LiquidityOperationKind" AS ENUM ('DEPOSIT', 'WITHDRAW');

-- CreateTable
CREATE TABLE "liquidity_pool_operation" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "kind" "LiquidityOperationKind" NOT NULL,
    "network" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "poolId" TEXT NOT NULL,
    "assetA" TEXT NOT NULL DEFAULT 'native',
    "assetAIssuer" TEXT,
    "assetB" TEXT NOT NULL DEFAULT 'native',
    "assetBIssuer" TEXT,
    "amountA" TEXT NOT NULL,
    "amountB" TEXT NOT NULL,
    "shares" TEXT,
    "minPrice" TEXT,
    "maxPrice" TEXT,
    "slippageBps" INTEGER NOT NULL,
    "feeBps" INTEGER NOT NULL DEFAULT 0,
    "feeAmountA" TEXT NOT NULL DEFAULT '0',
    "feeAmountB" TEXT NOT NULL DEFAULT '0',
    "feeWallet" TEXT,
    "status" "SwapStatus" NOT NULL DEFAULT 'PENDING',
    "xdr" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "liquidity_pool_operation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "liquidity_pool_operation_consumerId_idx" ON "liquidity_pool_operation"("consumerId");

-- CreateIndex
CREATE INDEX "liquidity_pool_operation_status_idx" ON "liquidity_pool_operation"("status");

-- CreateIndex
CREATE INDEX "liquidity_pool_operation_txHash_idx" ON "liquidity_pool_operation"("txHash");

-- CreateIndex
CREATE INDEX "liquidity_pool_operation_poolId_idx" ON "liquidity_pool_operation"("poolId");

-- AddForeignKey
ALTER TABLE "liquidity_pool_operation" ADD CONSTRAINT "liquidity_pool_operation_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
