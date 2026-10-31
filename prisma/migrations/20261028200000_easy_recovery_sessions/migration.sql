-- Easy recovery: a five-minute mailbox that moves a wallet from an old device to a new one.
-- The row holds only what the old device sealed to the new device's X25519 key and the
-- hash of the code shown on the old device's screen; this service cannot open it.

-- CreateEnum
CREATE TYPE "EasyRecoveryStatus" AS ENUM ('OPEN', 'OFFERED', 'CLAIMED');

-- CreateTable
CREATE TABLE "easy_recovery_session" (
    "id" TEXT NOT NULL,
    "receiverKey" TEXT NOT NULL,
    "status" "EasyRecoveryStatus" NOT NULL DEFAULT 'OPEN',
    "ciphertext" TEXT,
    "codeHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "easy_recovery_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "easy_recovery_session_expiresAt_idx" ON "easy_recovery_session"("expiresAt");
