-- AlterEnum
ALTER TYPE "WebhookEventType" ADD VALUE 'RECEIVER_UPDATED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PAYIN_CREATED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PAYIN_UPDATED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PAYIN_COMPLETED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PAYOUT_CREATED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PAYOUT_UPDATED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PAYOUT_COMPLETED';

-- CreateTable
CREATE TABLE "blindpay_receiver" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "blindpayId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "kycType" TEXT,
    "kycStatus" TEXT,
    "email" TEXT,
    "name" TEXT,
    "country" TEXT,
    "externalId" TEXT,
    "reference" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blindpay_receiver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blindpay_blockchain_wallet" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "blindpayId" TEXT NOT NULL,
    "name" TEXT,
    "network" TEXT NOT NULL,
    "address" TEXT,
    "isAccountAbstraction" BOOLEAN NOT NULL DEFAULT false,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blindpay_blockchain_wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blindpay_bank_account" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "blindpayId" TEXT NOT NULL,
    "rail" TEXT,
    "name" TEXT,
    "country" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blindpay_bank_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blindpay_virtual_account" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "blindpayId" TEXT NOT NULL,
    "blockchainWalletId" TEXT,
    "token" TEXT,
    "status" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blindpay_virtual_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payin" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "receiverId" TEXT,
    "blindpayId" TEXT NOT NULL,
    "quoteId" TEXT,
    "status" TEXT,
    "token" TEXT,
    "network" TEXT,
    "paymentMethod" TEXT,
    "currency" TEXT,
    "senderAmount" TEXT,
    "receiverAmount" TEXT,
    "instructions" JSONB,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "receiverId" TEXT,
    "blindpayId" TEXT NOT NULL,
    "quoteId" TEXT,
    "status" TEXT,
    "token" TEXT,
    "network" TEXT,
    "rail" TEXT,
    "bankAccountId" TEXT,
    "senderAmount" TEXT,
    "receiverAmount" TEXT,
    "senderWalletAddress" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "blindpay_receiver_consumerId_idx" ON "blindpay_receiver"("consumerId");

-- CreateIndex
CREATE UNIQUE INDEX "blindpay_receiver_consumerId_blindpayId_key" ON "blindpay_receiver"("consumerId", "blindpayId");

-- CreateIndex
CREATE INDEX "blindpay_blockchain_wallet_consumerId_idx" ON "blindpay_blockchain_wallet"("consumerId");

-- CreateIndex
CREATE INDEX "blindpay_blockchain_wallet_receiverId_idx" ON "blindpay_blockchain_wallet"("receiverId");

-- CreateIndex
CREATE UNIQUE INDEX "blindpay_blockchain_wallet_consumerId_blindpayId_key" ON "blindpay_blockchain_wallet"("consumerId", "blindpayId");

-- CreateIndex
CREATE INDEX "blindpay_bank_account_consumerId_idx" ON "blindpay_bank_account"("consumerId");

-- CreateIndex
CREATE INDEX "blindpay_bank_account_receiverId_idx" ON "blindpay_bank_account"("receiverId");

-- CreateIndex
CREATE UNIQUE INDEX "blindpay_bank_account_consumerId_blindpayId_key" ON "blindpay_bank_account"("consumerId", "blindpayId");

-- CreateIndex
CREATE INDEX "blindpay_virtual_account_consumerId_idx" ON "blindpay_virtual_account"("consumerId");

-- CreateIndex
CREATE INDEX "blindpay_virtual_account_receiverId_idx" ON "blindpay_virtual_account"("receiverId");

-- CreateIndex
CREATE UNIQUE INDEX "blindpay_virtual_account_consumerId_blindpayId_key" ON "blindpay_virtual_account"("consumerId", "blindpayId");

-- CreateIndex
CREATE INDEX "payin_consumerId_idx" ON "payin"("consumerId");

-- CreateIndex
CREATE INDEX "payin_receiverId_idx" ON "payin"("receiverId");

-- CreateIndex
CREATE INDEX "payin_status_idx" ON "payin"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payin_consumerId_blindpayId_key" ON "payin"("consumerId", "blindpayId");

-- CreateIndex
CREATE INDEX "payout_consumerId_idx" ON "payout"("consumerId");

-- CreateIndex
CREATE INDEX "payout_receiverId_idx" ON "payout"("receiverId");

-- CreateIndex
CREATE INDEX "payout_status_idx" ON "payout"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payout_consumerId_blindpayId_key" ON "payout"("consumerId", "blindpayId");

-- AddForeignKey
ALTER TABLE "blindpay_receiver" ADD CONSTRAINT "blindpay_receiver_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blindpay_blockchain_wallet" ADD CONSTRAINT "blindpay_blockchain_wallet_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "blindpay_receiver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blindpay_bank_account" ADD CONSTRAINT "blindpay_bank_account_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "blindpay_receiver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blindpay_virtual_account" ADD CONSTRAINT "blindpay_virtual_account_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "blindpay_receiver"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payin" ADD CONSTRAINT "payin_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payin" ADD CONSTRAINT "payin_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "blindpay_receiver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout" ADD CONSTRAINT "payout_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout" ADD CONSTRAINT "payout_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "blindpay_receiver"("id") ON DELETE SET NULL ON UPDATE CASCADE;
