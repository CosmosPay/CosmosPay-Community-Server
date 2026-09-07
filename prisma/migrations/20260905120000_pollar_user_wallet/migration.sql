-- Per-network Pollar wallet provisioning state.
--
-- Pollar runs mainnet and testnet as two separate applications with two separate
-- key pairs, so one hosted login can only ever produce a wallet on the network
-- its API key resolved to. A redemption now provisions the counterpart network
-- too, best-effort, and this table remembers whether that attempt landed.
--
-- It is not a mirror of Pollar's wallet — Pollar owns that — it records whether
-- WE have managed to ask for it yet, so a failed attempt can be retried after
-- the handshake row it came from has been swept away.

-- CreateEnum
CREATE TYPE "PollarWalletStatus" AS ENUM ('PENDING', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "pollar_user_wallet" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "status" "PollarWalletStatus" NOT NULL DEFAULT 'PENDING',
    "address" TEXT,
    "walletType" TEXT,
    "pollarUserId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pollar_user_wallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One row per user per network: this is the idempotency of the whole feature,
-- so repeat logins upsert instead of fanning out into duplicate attempts.
CREATE UNIQUE INDEX "pollar_user_wallet_consumerId_externalId_network_key" ON "pollar_user_wallet"("consumerId", "externalId", "network");

-- CreateIndex
CREATE INDEX "pollar_user_wallet_status_nextAttemptAt_idx" ON "pollar_user_wallet"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "pollar_user_wallet" ADD CONSTRAINT "pollar_user_wallet_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
