-- Pollar OAuth bridge: one row per handshake in flight.
--
-- The table holds no Pollar token. `codeHash` is the SHA-256 of the single-use
-- bridge code (the code itself never lands here), and the Pollar session is
-- redeemed for tokens only during the redemption request, which hands them
-- straight to the wallet.

-- CreateEnum
CREATE TYPE "PollarOauthStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'EXCHANGING', 'CONSUMED', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "pollar_oauth_session" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" "PollarOauthStatus" NOT NULL DEFAULT 'PENDING',
    "network" TEXT NOT NULL,
    "clientSessionId" TEXT NOT NULL,
    "redirectUri" TEXT,
    "codeChallenge" TEXT,
    "dpopJwk" JSONB,
    "deviceLabel" TEXT,
    "codeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "walletAddress" TEXT,
    "walletType" TEXT,
    "pollarUserId" TEXT,
    "errorCode" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pollar_oauth_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pollar_oauth_session_state_key" ON "pollar_oauth_session"("state");

-- CreateIndex
CREATE UNIQUE INDEX "pollar_oauth_session_codeHash_key" ON "pollar_oauth_session"("codeHash");

-- CreateIndex
CREATE INDEX "pollar_oauth_session_consumerId_createdAt_idx" ON "pollar_oauth_session"("consumerId", "createdAt");

-- CreateIndex
CREATE INDEX "pollar_oauth_session_status_expiresAt_idx" ON "pollar_oauth_session"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "pollar_oauth_session" ADD CONSTRAINT "pollar_oauth_session_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
