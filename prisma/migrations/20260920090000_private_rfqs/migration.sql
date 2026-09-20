ALTER TYPE "WebhookEventType" ADD VALUE 'PRIVATE_RFQ_CREATED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PRIVATE_RFQ_REVEALED';
ALTER TYPE "WebhookEventType" ADD VALUE 'PRIVATE_RFQ_SELECTED';

CREATE TYPE "PrivateRfqStatus" AS ENUM (
  'OPEN',
  'REVEALING',
  'REVEALED',
  'SELECTED',
  'VOIDED'
);

CREATE TABLE "private_rfq" (
  "id" TEXT NOT NULL,
  "consumerId" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "network" TEXT NOT NULL,
  "contractId" TEXT NOT NULL,
  "roundId" TEXT NOT NULL,
  "status" "PrivateRfqStatus" NOT NULL DEFAULT 'OPEN',
  "roundStatus" TEXT NOT NULL,
  "commitDeadline" TIMESTAMP(3) NOT NULL,
  "revealDeadline" TIMESTAMP(3) NOT NULL,
  "assetCode" TEXT NOT NULL DEFAULT 'native',
  "assetIssuer" TEXT,
  "assetDecimals" INTEGER NOT NULL DEFAULT 7,
  "selectedProvider" TEXT,
  "selectedAmount" TEXT,
  "selectedAt" TIMESTAMP(3),
  "revealedAt" TIMESTAMP(3),
  "paymentIntentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "private_rfq_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "private_rfq_paymentIntentId_key"
  ON "private_rfq"("paymentIntentId");
CREATE UNIQUE INDEX "private_rfq_consumerId_reference_key"
  ON "private_rfq"("consumerId", "reference");
CREATE UNIQUE INDEX "private_rfq_network_contractId_roundId_key"
  ON "private_rfq"("network", "contractId", "roundId");
CREATE INDEX "private_rfq_consumerId_createdAt_idx"
  ON "private_rfq"("consumerId", "createdAt");

ALTER TABLE "private_rfq"
  ADD CONSTRAINT "private_rfq_consumerId_fkey"
  FOREIGN KEY ("consumerId") REFERENCES "consumer"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "private_rfq"
  ADD CONSTRAINT "private_rfq_paymentIntentId_fkey"
  FOREIGN KEY ("paymentIntentId") REFERENCES "payment_intent"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
