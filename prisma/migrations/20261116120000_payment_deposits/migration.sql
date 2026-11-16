-- Payment links on every network the cross-chain route reaches: the
-- `payment_deposit` table (a deposit address made for one payer of one payment
-- intent), `payment_deposit_reservation` (the slots held while one is being
-- opened), and on `payment_intent` the plan commission such a payment pays
-- (`crossChainFeeBps`) and what the payer sent when one settled it (`paidFrom`).
--
-- New tables and nullable columns only; nothing existing is rewritten, so it
-- applies online on every database. `payment_intent.chain` is TEXT already: a
-- link on a new network needs no change to it.
-- AlterTable
ALTER TABLE "payment_intent" ADD COLUMN     "crossChainFeeBps" INTEGER,
ADD COLUMN     "paidFrom" JSONB;

-- CreateTable
CREATE TABLE "payment_deposit" (
    "id" TEXT NOT NULL,
    "intentId" TEXT,
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
    "minAmountIn" TEXT NOT NULL,
    "amountOut" TEXT NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "feeAmount" TEXT NOT NULL,
    "slippageBps" INTEGER NOT NULL,
    "recipient" TEXT NOT NULL,
    "refundTo" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "depositAddress" TEXT NOT NULL,
    "depositMemo" TEXT,
    "depositUri" TEXT,
    "amountOutPaid" TEXT,
    "refundedAmount" TEXT,
    "originTxHashes" JSONB,
    "destinationTxHashes" JSONB,
    "timeEstimateSeconds" INTEGER NOT NULL,
    "correlationId" TEXT NOT NULL,
    "quoteSignature" TEXT NOT NULL,
    "quote" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_deposit_reservation" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "clientKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_deposit_reservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payment_deposit_intentId_createdAt_idx" ON "payment_deposit"("intentId", "createdAt");

-- CreateIndex
CREATE INDEX "payment_deposit_status_lastCheckedAt_idx" ON "payment_deposit"("status", "lastCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payment_deposit_depositAddress_depositMemo_key" ON "payment_deposit"("depositAddress", "depositMemo");

-- CreateIndex
CREATE INDEX "payment_deposit_reservation_intentId_clientKey_idx" ON "payment_deposit_reservation"("intentId", "clientKey");

-- AddForeignKey
ALTER TABLE "payment_deposit" ADD CONSTRAINT "payment_deposit_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_deposit_reservation" ADD CONSTRAINT "payment_deposit_reservation_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "payment_intent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

