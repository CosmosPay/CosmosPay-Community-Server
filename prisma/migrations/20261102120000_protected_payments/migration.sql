-- Protected payments (native plugin `trustless-work`): the protected payment a
-- merchant creates, mirrored from its Trustless Work contract, and the transactions
-- this service built for it, so a submit relays only a signed copy of one of them.
--
-- Two new tables, five new enums and ten webhook event types; nothing existing is
-- rewritten. The enum values are appended (ADD VALUE cannot insert) and none is used
-- in this migration, so adding them inside its transaction is safe on PostgreSQL 12+.
-- CreateEnum
CREATE TYPE "ProtectedPaymentStatus" AS ENUM ('CREATED', 'AWAITING_FUNDING', 'FUNDED', 'SHIPPED', 'APPROVED', 'RELEASED', 'DISPUTED', 'RESOLVED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProtectedPaymentReleaseModel" AS ENUM ('BUYER_RELEASES', 'MERCHANT_RELEASES', 'BUYER_APPROVES_MERCHANT_RELEASES');

-- CreateEnum
CREATE TYPE "ProtectedPaymentDeadlinePolicy" AS ENUM ('MANUAL_REVIEW', 'REFUND_BUYER', 'RELEASE_MERCHANT');

-- CreateEnum
CREATE TYPE "ProtectedPaymentAction" AS ENUM ('DEPLOY', 'FUND', 'SHIP', 'APPROVE', 'RELEASE', 'DISPUTE', 'RESOLVE');

-- CreateEnum
CREATE TYPE "ProtectedPaymentTransactionStatus" AS ENUM ('BUILT', 'SUBMITTING', 'SUBMITTED');

-- AlterEnum
ALTER TYPE "WebhookEventType" ADD VALUE 'PROTECTED_PAYMENT_CREATED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PROTECTED_PAYMENT_FUNDED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PROTECTED_PAYMENT_SHIPPED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PROTECTED_PAYMENT_APPROVED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PROTECTED_PAYMENT_RELEASED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PROTECTED_PAYMENT_DISPUTED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PROTECTED_PAYMENT_RESOLVED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PROTECTED_PAYMENT_DEADLINE_PASSED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PROTECTED_PAYMENT_EXPIRED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PROTECTED_PAYMENT_CANCELLED';

-- CreateTable
CREATE TABLE "protected_payment" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "status" "ProtectedPaymentStatus" NOT NULL DEFAULT 'CREATED',
    "releaseModel" "ProtectedPaymentReleaseModel" NOT NULL,
    "deadlinePolicy" "ProtectedPaymentDeadlinePolicy" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "reference" TEXT,
    "amount" TEXT NOT NULL,
    "asset" TEXT NOT NULL DEFAULT 'USDC',
    "assetIssuer" TEXT NOT NULL,
    "merchantAddress" TEXT NOT NULL,
    "buyerAddress" TEXT,
    "platformAddress" TEXT NOT NULL,
    "disputeResolverAddress" TEXT,
    "platformFeeBps" INTEGER NOT NULL,
    "contractId" TEXT,
    "idempotencyKey" TEXT,
    "fundingExpiresAt" TIMESTAMP(3) NOT NULL,
    "deliveryWindowHours" INTEGER NOT NULL,
    "deliveryDeadlineAt" TIMESTAMP(3),
    "deadlinePassedAt" TIMESTAMP(3),
    "evidence" TEXT,
    "fundedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "disputedAt" TIMESTAMP(3),
    "disputedBy" TEXT,
    "disputeReason" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolution" JSONB,
    "cancelledAt" TIMESTAMP(3),
    "deployClaimedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "protected_payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "protected_payment_transaction" (
    "id" TEXT NOT NULL,
    "protectedPaymentId" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "action" "ProtectedPaymentAction" NOT NULL,
    "status" "ProtectedPaymentTransactionStatus" NOT NULL DEFAULT 'BUILT',
    "signer" TEXT NOT NULL,
    "xdr" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "context" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "protected_payment_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "protected_payment_contractId_key" ON "protected_payment"("contractId");

-- CreateIndex
CREATE INDEX "protected_payment_consumerId_network_status_idx" ON "protected_payment"("consumerId", "network", "status");

-- CreateIndex
CREATE INDEX "protected_payment_status_deliveryDeadlineAt_idx" ON "protected_payment"("status", "deliveryDeadlineAt");

-- CreateIndex
CREATE UNIQUE INDEX "protected_payment_consumerId_idempotencyKey_key" ON "protected_payment"("consumerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "protected_payment_transaction_protectedPaymentId_action_idx" ON "protected_payment_transaction"("protectedPaymentId", "action");

-- CreateIndex
CREATE UNIQUE INDEX "protected_payment_transaction_consumerId_txHash_key" ON "protected_payment_transaction"("consumerId", "txHash");

-- AddForeignKey
ALTER TABLE "protected_payment" ADD CONSTRAINT "protected_payment_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protected_payment_transaction" ADD CONSTRAINT "protected_payment_transaction_protectedPaymentId_fkey" FOREIGN KEY ("protectedPaymentId") REFERENCES "protected_payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "protected_payment_transaction" ADD CONSTRAINT "protected_payment_transaction_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
