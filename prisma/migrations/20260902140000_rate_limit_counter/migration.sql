-- Rate limiting: one row per (policy + subject, window).
--
-- Shared in Postgres rather than per-replica in memory: an in-process counter
-- would give each replica the full budget, multiplying the effective limit by
-- the replica count. The routes this guards spend XLM on every call, so that
-- multiplication is a funding-drain hole, not a rounding error.

-- CreateTable
CREATE TABLE "rate_limit_counter" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_limit_counter_pkey" PRIMARY KEY ("key","windowStart")
);

-- CreateIndex
CREATE INDEX "rate_limit_counter_expiresAt_idx" ON "rate_limit_counter"("expiresAt");
