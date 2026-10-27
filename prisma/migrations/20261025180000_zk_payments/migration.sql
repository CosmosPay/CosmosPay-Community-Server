-- ZK payments: payments on Cosmos Pay's confidential token, amount hidden on-chain.
--
-- A new table, a new status enum and one webhook event type; nothing existing is
-- rewritten. The enum value is appended (ADD VALUE cannot insert) and is not used
-- in this migration, so adding it inside its transaction is safe on PostgreSQL 12+.
-- CreateEnum
CREATE TYPE "ZkPaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "WebhookEventType" ADD VALUE 'ZK_PAYMENT_SUCCEEDED';

-- CreateTable
CREATE TABLE "zk_payment" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "tokenContract" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "netAmount" TEXT NOT NULL,
    "feeAmount" TEXT NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "recipient" TEXT NOT NULL,
    "feeAccount" TEXT NOT NULL,
    "payer" TEXT,
    "paymentTxHash" TEXT,
    "feeTxHash" TEXT,
    "description" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "ZkPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zk_payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "zk_payment_paymentTxHash_key" ON "zk_payment"("paymentTxHash");

-- CreateIndex
CREATE UNIQUE INDEX "zk_payment_feeTxHash_key" ON "zk_payment"("feeTxHash");

-- CreateIndex
CREATE INDEX "zk_payment_consumerId_idx" ON "zk_payment"("consumerId");

-- CreateIndex
CREATE INDEX "zk_payment_consumerId_createdAt_idx" ON "zk_payment"("consumerId", "createdAt");

-- CreateIndex
CREATE INDEX "zk_payment_consumerId_network_createdAt_idx" ON "zk_payment"("consumerId", "network", "createdAt");

-- CreateIndex
CREATE INDEX "zk_payment_status_createdAt_idx" ON "zk_payment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "zk_payment_consumerId_idempotencyKey_key" ON "zk_payment"("consumerId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "zk_payment" ADD CONSTRAINT "zk_payment_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

