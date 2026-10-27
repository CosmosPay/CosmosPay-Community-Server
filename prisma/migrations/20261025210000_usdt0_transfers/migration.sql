-- USDT0 transfers: USDT0 sent from Stellar to an EVM network through LayerZero's OFT.
--
-- A new table and a new status enum; nothing existing is rewritten.
-- CreateEnum
CREATE TYPE "Usdt0TransferStatus" AS ENUM ('PENDING', 'SUBMITTED', 'DELIVERED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "usdt0_transfer" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "status" "Usdt0TransferStatus" NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "eid" INTEGER NOT NULL,
    "receives" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "amountSent" TEXT NOT NULL,
    "amountReceived" TEXT NOT NULL,
    "nativeFee" TEXT NOT NULL,
    "nativeFeeLimit" TEXT NOT NULL,
    "networkFee" TEXT NOT NULL,
    "xdr" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "guid" TEXT,
    "destinationTxHash" TEXT,
    "scanStatus" TEXT,
    "failureReason" TEXT,
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastCheckedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "usdt0_transfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usdt0_transfer_txHash_key" ON "usdt0_transfer"("txHash");

-- CreateIndex
CREATE INDEX "usdt0_transfer_consumerId_createdAt_idx" ON "usdt0_transfer"("consumerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "usdt0_transfer_consumerId_idempotencyKey_key" ON "usdt0_transfer"("consumerId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "usdt0_transfer" ADD CONSTRAINT "usdt0_transfer_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

