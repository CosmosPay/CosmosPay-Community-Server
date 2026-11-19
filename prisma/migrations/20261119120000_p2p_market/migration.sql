-- The P2P market (`src/p2p/`): wallets consumers registered, their payment
-- methods and offers, quotes, orders mirrored from `contracts/P2PMarket.sol`,
-- charges, payout batches, the matcher's signed transactions and the indexer's
-- cursors. Ten new tables and eleven webhook event types; nothing existing is
-- rewritten. The enum values are appended (ADD VALUE cannot insert) and none is
-- used in this migration, so adding them inside its transaction is safe on
-- PostgreSQL 12+.

-- AlterEnum
ALTER TYPE "WebhookEventType" ADD VALUE 'P2P_ORDER_CREATED';
ALTER TYPE "WebhookEventType" ADD VALUE 'P2P_ORDER_ACCEPTED';
ALTER TYPE "WebhookEventType" ADD VALUE 'P2P_ORDER_PAID';
ALTER TYPE "WebhookEventType" ADD VALUE 'P2P_ORDER_COMPLETED';
ALTER TYPE "WebhookEventType" ADD VALUE 'P2P_ORDER_CANCELLED';
ALTER TYPE "WebhookEventType" ADD VALUE 'P2P_ORDER_EXPIRED';
ALTER TYPE "WebhookEventType" ADD VALUE 'P2P_ORDER_DISPUTED';
ALTER TYPE "WebhookEventType" ADD VALUE 'P2P_ORDER_RESOLVED';
ALTER TYPE "WebhookEventType" ADD VALUE 'P2P_ORDER_FAILED';
ALTER TYPE "WebhookEventType" ADD VALUE 'P2P_CHARGE_SUCCEEDED';
ALTER TYPE "WebhookEventType" ADD VALUE 'P2P_PAYOUT_BATCH_COMPLETED';

-- CreateTable
CREATE TABLE "p2p_account" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "displayName" TEXT,
    "merchantStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "completedOrders" INTEGER NOT NULL DEFAULT 0,
    "cancelledOrders" INTEGER NOT NULL DEFAULT 0,
    "disputesLost" INTEGER NOT NULL DEFAULT 0,
    "medianReleaseSeconds" INTEGER,
    "lastActiveAt" TIMESTAMP(3),
    "operators" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_account_challenge" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "p2p_account_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_payment_method" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rail" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "holderName" TEXT NOT NULL,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_payment_method_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_offer" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rails" TEXT[],
    "price" TEXT NOT NULL,
    "priceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "priceTtlSeconds" INTEGER NOT NULL,
    "minFiat" TEXT NOT NULL,
    "maxFiat" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_quote" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rail" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "merchantAccountId" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "fiatAmount" TEXT NOT NULL,
    "tokenAmount" TEXT NOT NULL,
    "netAmount" TEXT NOT NULL,
    "protocolFeeBps" INTEGER NOT NULL,
    "protocolFee" TEXT NOT NULL,
    "integratorFeeBps" INTEGER NOT NULL,
    "integratorFee" TEXT NOT NULL,
    "integratorAddress" TEXT,
    "bond" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "p2p_quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_order" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contract" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "tokenSymbol" TEXT NOT NULL,
    "tokenDecimals" INTEGER NOT NULL,
    "merchantAccountId" TEXT,
    "merchantConsumerId" TEXT NOT NULL,
    "merchantAddress" TEXT NOT NULL,
    "merchantDisplayName" TEXT,
    "merchantPaymentMethodId" TEXT,
    "offerId" TEXT,
    "offerSnapshot" JSONB NOT NULL,
    "quoteId" TEXT,
    "price" TEXT NOT NULL,
    "fiatAmount" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rail" TEXT NOT NULL,
    "tokenAmount" TEXT NOT NULL,
    "netAmount" TEXT NOT NULL,
    "protocolFeeBps" INTEGER NOT NULL,
    "integratorFeeBps" INTEGER NOT NULL,
    "integratorAddress" TEXT,
    "sellerAddress" TEXT NOT NULL,
    "buyerAddress" TEXT NOT NULL,
    "bond" TEXT NOT NULL,
    "acceptWindow" INTEGER NOT NULL,
    "paymentWindow" INTEGER NOT NULL,
    "settleWindow" INTEGER NOT NULL,
    "openerAddress" TEXT NOT NULL,
    "onchainId" TEXT,
    "chainStatus" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "acceptDeadline" TIMESTAMP(3),
    "paymentDeadline" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "openTxHash" TEXT,
    "acceptTxHash" TEXT,
    "paidTxHash" TEXT,
    "releaseTxHash" TEXT,
    "cancelTxHash" TEXT,
    "disputeTxHash" TEXT,
    "resolveTxHash" TEXT,
    "settlement" JSONB,
    "payerInfo" TEXT,
    "beneficiary" TEXT,
    "paidReference" TEXT,
    "failureReason" TEXT,
    "chargeId" TEXT,
    "payoutBatchId" TEXT,
    "externalReference" TEXT,
    "payerTokenHash" TEXT,
    "clientKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_charge" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "fiatAmount" TEXT NOT NULL,
    "recipientAccountId" TEXT NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "description" TEXT,
    "multiUse" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "paidCount" INTEGER NOT NULL DEFAULT 0,
    "paidAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_payout_batch" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sellerAddress" TEXT NOT NULL,
    "itemCount" INTEGER NOT NULL,
    "failedItems" JSONB,
    "status" TEXT NOT NULL DEFAULT 'processing',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_payout_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_matcher_tx" (
    "id" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "nonce" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "orderId" TEXT,
    "toAddress" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "raw" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'signed',
    "sentAt" TIMESTAMP(3),
    "minedBlock" BIGINT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_matcher_tx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "p2p_chain_cursor" (
    "tier" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contract" TEXT NOT NULL,
    "lastBlock" BIGINT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "p2p_chain_cursor_pkey" PRIMARY KEY ("tier","network","contract")
);

-- CreateIndex
CREATE INDEX "p2p_account_consumerId_tier_createdAt_idx" ON "p2p_account"("consumerId", "tier", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_account_tier_address_key" ON "p2p_account"("tier", "address");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_account_challenge_nonce_key" ON "p2p_account_challenge"("nonce");

-- CreateIndex
CREATE INDEX "p2p_account_challenge_expiresAt_idx" ON "p2p_account_challenge"("expiresAt");

-- CreateIndex
CREATE INDEX "p2p_payment_method_consumerId_tier_createdAt_idx" ON "p2p_payment_method"("consumerId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_payment_method_accountId_rail_currency_active_idx" ON "p2p_payment_method"("accountId", "rail", "currency", "active");

-- CreateIndex
CREATE INDEX "p2p_offer_tier_network_token_currency_side_active_idx" ON "p2p_offer"("tier", "network", "token", "currency", "side", "active");

-- CreateIndex
CREATE INDEX "p2p_offer_consumerId_tier_createdAt_idx" ON "p2p_offer"("consumerId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_quote_consumerId_tier_createdAt_idx" ON "p2p_quote"("consumerId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_quote_expiresAt_idx" ON "p2p_quote"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_order_ref_key" ON "p2p_order"("ref");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_order_quoteId_key" ON "p2p_order"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_order_payerTokenHash_key" ON "p2p_order"("payerTokenHash");

-- CreateIndex
CREATE INDEX "p2p_order_consumerId_tier_createdAt_idx" ON "p2p_order"("consumerId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_order_merchantConsumerId_tier_createdAt_idx" ON "p2p_order"("merchantConsumerId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_order_merchantAccountId_status_idx" ON "p2p_order"("merchantAccountId", "status");

-- CreateIndex
CREATE INDEX "p2p_order_status_updatedAt_idx" ON "p2p_order"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "p2p_order_chargeId_status_idx" ON "p2p_order"("chargeId", "status");

-- CreateIndex
CREATE INDEX "p2p_order_payoutBatchId_idx" ON "p2p_order"("payoutBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_order_tier_network_contract_onchainId_key" ON "p2p_order"("tier", "network", "contract", "onchainId");

-- CreateIndex
CREATE INDEX "p2p_charge_consumerId_tier_createdAt_idx" ON "p2p_charge"("consumerId", "tier", "createdAt");

-- CreateIndex
CREATE INDEX "p2p_payout_batch_consumerId_tier_createdAt_idx" ON "p2p_payout_batch"("consumerId", "tier", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_matcher_tx_hash_key" ON "p2p_matcher_tx"("hash");

-- CreateIndex
CREATE INDEX "p2p_matcher_tx_status_updatedAt_idx" ON "p2p_matcher_tx"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "p2p_matcher_tx_orderId_idx" ON "p2p_matcher_tx"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "p2p_matcher_tx_tier_network_fromAddress_nonce_key" ON "p2p_matcher_tx"("tier", "network", "fromAddress", "nonce");

-- AddForeignKey
ALTER TABLE "p2p_account" ADD CONSTRAINT "p2p_account_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_payment_method" ADD CONSTRAINT "p2p_payment_method_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "p2p_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_offer" ADD CONSTRAINT "p2p_offer_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "p2p_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_quote" ADD CONSTRAINT "p2p_quote_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_order" ADD CONSTRAINT "p2p_order_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_order" ADD CONSTRAINT "p2p_order_merchantAccountId_fkey" FOREIGN KEY ("merchantAccountId") REFERENCES "p2p_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_order" ADD CONSTRAINT "p2p_order_chargeId_fkey" FOREIGN KEY ("chargeId") REFERENCES "p2p_charge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_order" ADD CONSTRAINT "p2p_order_payoutBatchId_fkey" FOREIGN KEY ("payoutBatchId") REFERENCES "p2p_payout_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_charge" ADD CONSTRAINT "p2p_charge_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "p2p_payout_batch" ADD CONSTRAINT "p2p_payout_batch_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

