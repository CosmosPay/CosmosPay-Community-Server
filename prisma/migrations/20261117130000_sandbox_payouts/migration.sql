-- Sandbox settlement (payment links on test networks): the transactions the
-- sandbox treasury sends, one payout and at most one refund per sandbox
-- deposit. A new table only; nothing existing is touched.
-- CreateTable
CREATE TABLE "sandbox_payout" (
    "id" TEXT NOT NULL,
    "depositId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sandbox_payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_payout_txHash_key" ON "sandbox_payout"("txHash");

-- CreateIndex
CREATE UNIQUE INDEX "sandbox_payout_depositId_kind_key" ON "sandbox_payout"("depositId", "kind");

