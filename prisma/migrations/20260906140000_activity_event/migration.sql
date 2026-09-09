-- Client activity / telemetry reported by the wallet and the developer dashboard.
--
-- `request_log` only ever sees what reached this service. The events worth
-- having when something breaks — a crash on the send screen, a cancelled
-- signature, a page that threw before any request left the browser — never
-- produce an HTTP call here at all, so the clients report their own.
--
-- Scoped to the authenticated consumer (never to anything in the body) and
-- pruned with the request log, since a row holds an IP, a user agent and
-- whatever the client put in `props`.

-- CreateTable
CREATE TABLE "activity_event" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "eventId" TEXT,
    "source" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT,
    "sessionId" TEXT,
    "distinctId" TEXT,
    "appVersion" TEXT,
    "platform" TEXT,
    "network" TEXT,
    "durationMs" INTEGER,
    "props" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "activity_event_consumerId_eventId_key" ON "activity_event"("consumerId", "eventId");

-- CreateIndex
CREATE INDEX "activity_event_consumerId_occurredAt_idx" ON "activity_event"("consumerId", "occurredAt");

-- CreateIndex
CREATE INDEX "activity_event_consumerId_level_occurredAt_idx" ON "activity_event"("consumerId", "level", "occurredAt");

-- CreateIndex
CREATE INDEX "activity_event_consumerId_source_occurredAt_idx" ON "activity_event"("consumerId", "source", "occurredAt");

-- CreateIndex
CREATE INDEX "activity_event_createdAt_idx" ON "activity_event"("createdAt");

-- AddForeignKey
ALTER TABLE "activity_event" ADD CONSTRAINT "activity_event_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
