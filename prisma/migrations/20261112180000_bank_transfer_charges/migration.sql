-- Charges in local money paid by bank transfer (native plugin `koywe`): on
-- `p2p_payment_request` the ways it can be paid (`methods`) and how it was paid
-- (`paidMethod`), and the plugin's own tables: each seller's provider account
-- (one per consumer and network), the transfers payers announce, every webhook
-- delivery by its envelope id, each deposit and what became of it, and the
-- provider's crypto account per merchant and seller address.
--
-- `status` gains the value `processing` (a bank transfer arrived, the token is on
-- its way): a TEXT column, so nothing changes in the schema for it.
--
-- New tables and nullable or defaulted columns only. The two UPDATEs fill the new
-- columns of existing requests with what they were: every one was created for
-- the P2P marketplace alone, and every paid one was paid through it.
-- AlterTable
ALTER TABLE "p2p_payment_request" ADD COLUMN     "methods" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "paidMethod" TEXT;

-- CreateTable
CREATE TABLE "bank_transfer_account" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxIdHint" TEXT NOT NULL,
    "providerMerchantId" TEXT,
    "kybId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "verificationUrl" TEXT,
    "kybCheckedAt" TIMESTAMP(3),
    "virtualAccountId" TEXT,
    "alias" TEXT,
    "cvu" TEXT,
    "bank" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_transfer_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transfer" (
    "id" TEXT NOT NULL,
    "paymentRequestId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "providerMerchantId" TEXT NOT NULL,
    "documentHash" TEXT NOT NULL,
    "documentHint" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "instructedAmount" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_deposit',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "depositAmount" TEXT,
    "depositReference" TEXT,
    "depositedAt" TIMESTAMP(3),
    "providerQuoteId" TEXT,
    "providerOrderId" TEXT,
    "providerStatus" TEXT,
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "deliveredAmount" TEXT,
    "txHash" TEXT,
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bank_transfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transfer_webhook_event" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_transfer_webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_income_event" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "merchantId" TEXT,
    "outcome" TEXT NOT NULL,
    "amount" TEXT,
    "currency" TEXT,
    "documentHash" TEXT,
    "documentHint" TEXT,
    "reference" TEXT,
    "transferId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_income_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_transfer_crypto_account" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "providerNetwork" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_transfer_crypto_account_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bank_transfer_account_network_status_idx" ON "bank_transfer_account"("network", "status");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transfer_account_consumerId_network_key" ON "bank_transfer_account"("consumerId", "network");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transfer_account_network_providerMerchantId_key" ON "bank_transfer_account"("network", "providerMerchantId");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transfer_providerOrderId_key" ON "bank_transfer"("providerOrderId");

-- CreateIndex
CREATE INDEX "bank_transfer_network_providerMerchantId_documentHash_statu_idx" ON "bank_transfer"("network", "providerMerchantId", "documentHash", "status", "createdAt");

-- CreateIndex
CREATE INDEX "bank_transfer_status_nextAttemptAt_idx" ON "bank_transfer"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transfer_paymentRequestId_documentHash_key" ON "bank_transfer"("paymentRequestId", "documentHash");

-- CreateIndex
CREATE INDEX "bank_transfer_webhook_event_createdAt_idx" ON "bank_transfer_webhook_event"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "bank_income_event_eventId_key" ON "bank_income_event"("eventId");

-- CreateIndex
CREATE INDEX "bank_income_event_network_outcome_createdAt_idx" ON "bank_income_event"("network", "outcome", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "bank_transfer_crypto_account_network_merchantId_providerNet_key" ON "bank_transfer_crypto_account"("network", "merchantId", "providerNetwork", "token", "address");

-- AddForeignKey
ALTER TABLE "bank_transfer_account" ADD CONSTRAINT "bank_transfer_account_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: the requests created before other rails existed.
UPDATE "p2p_payment_request" SET "methods" = ARRAY['p2p']::TEXT[];
UPDATE "p2p_payment_request" SET "paidMethod" = 'p2p' WHERE "paidAt" IS NOT NULL;
