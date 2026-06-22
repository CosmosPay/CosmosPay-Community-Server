-- CreateEnum
CREATE TYPE "WebhookEventType" AS ENUM ('PAYMENT_INTENT_CREATED', 'PAYMENT_INTENT_UPDATED', 'PAYMENT_INTENT_SUCCEEDED', 'PAYMENT_INTENT_FAILED', 'PAYMENT_INTENT_CANCELLED', 'PAYMENT_INTENT_DELETED');

-- CreateEnum
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentIntentStatus" AS ENUM ('PENDING', 'SUBMITTED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentIntentKind" AS ENUM ('TX', 'PAY');

-- CreateTable
CREATE TABLE "consumer" (
    "id" TEXT NOT NULL,
    "apisixUsername" TEXT NOT NULL,
    "credentialId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consumer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoint" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "eventTypes" "WebhookEventType"[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_delivery" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventType" "WebhookEventType" NOT NULL,
    "eventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "error" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_intent" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "kind" "PaymentIntentKind" NOT NULL DEFAULT 'TX',
    "source" TEXT,
    "destination" TEXT NOT NULL,
    "amount" TEXT,
    "asset" TEXT NOT NULL DEFAULT 'native',
    "assetIssuer" TEXT,
    "memo" TEXT,
    "network" TEXT NOT NULL,
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'PENDING',
    "xdr" TEXT,
    "uri" TEXT NOT NULL,
    "txHash" TEXT,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_intent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "consumer_apisixUsername_key" ON "consumer"("apisixUsername");

-- CreateIndex
CREATE INDEX "webhook_endpoint_consumerId_idx" ON "webhook_endpoint"("consumerId");

-- CreateIndex
CREATE INDEX "webhook_delivery_endpointId_idx" ON "webhook_delivery"("endpointId");

-- CreateIndex
CREATE INDEX "webhook_delivery_status_idx" ON "webhook_delivery"("status");

-- CreateIndex
CREATE INDEX "webhook_delivery_eventId_idx" ON "webhook_delivery"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intent_txHash_key" ON "payment_intent"("txHash");

-- CreateIndex
CREATE INDEX "payment_intent_consumerId_idx" ON "payment_intent"("consumerId");

-- CreateIndex
CREATE INDEX "payment_intent_status_idx" ON "payment_intent"("status");

-- AddForeignKey
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_intent" ADD CONSTRAINT "payment_intent_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
