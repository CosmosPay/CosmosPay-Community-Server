-- BlindPay payins and payouts are opened locally BEFORE the provider call, and
-- inbound webhooks that match no row are kept open for the reconciler instead of
-- being acknowledged and forgotten.
--
-- `blindpayId` becomes nullable (a row is `pending_provider` until the provider
-- answers), `executionKey` ties a row to its quote's idempotency key, and
-- `lastCheckedAt` orders the reconciler's batches. Nothing existing is rewritten
-- except the backfill below.

-- AlterTable
ALTER TABLE "payin" ADD COLUMN     "executionKey" TEXT,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ALTER COLUMN "blindpayId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "payout" ADD COLUMN     "executionKey" TEXT,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ALTER COLUMN "blindpayId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "blindpay_webhook_event" ADD COLUMN     "appliedAt" TIMESTAMP(3),
ADD COLUMN     "blindpayId" TEXT,
ADD COLUMN     "environment" TEXT,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3);

-- Every claim recorded before this migration was final the moment it was
-- inserted. Marking them applied keeps the reconciler from treating years of
-- history as open events (it could not attribute them anyway: they carry no
-- environment or resource id).
UPDATE "blindpay_webhook_event" SET "appliedAt" = "createdAt" WHERE "appliedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "payin_executionKey_key" ON "payin"("executionKey");

-- CreateIndex
CREATE INDEX "payin_environment_status_lastCheckedAt_idx" ON "payin"("environment", "status", "lastCheckedAt");

-- CreateIndex
CREATE UNIQUE INDEX "payout_executionKey_key" ON "payout"("executionKey");

-- CreateIndex
CREATE INDEX "payout_environment_status_lastCheckedAt_idx" ON "payout"("environment", "status", "lastCheckedAt");

-- CreateIndex
CREATE INDEX "blindpay_webhook_event_appliedAt_lastAttemptAt_idx" ON "blindpay_webhook_event"("appliedAt", "lastAttemptAt");
