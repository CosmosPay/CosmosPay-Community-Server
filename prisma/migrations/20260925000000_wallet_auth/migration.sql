-- CreateEnum
CREATE TYPE "WalletAuthMethod" AS ENUM ('GOOGLE', 'GITHUB', 'EMAIL');

-- CreateEnum
CREATE TYPE "WalletAuthProvider" AS ENUM ('GOOGLE', 'GITHUB');

-- CreateEnum
CREATE TYPE "WalletAuthHandshakeStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'REDEEMED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "WalletLoginCodeStatus" AS ENUM ('PENDING', 'CLAIMED', 'LOCKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "wallet_account" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "avatar" TEXT,
    "method" "WalletAuthMethod" NOT NULL,
    "stellarAddress" TEXT NOT NULL,
    "consumerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_backup" (
    "id" TEXT NOT NULL,
    "walletAccountId" TEXT NOT NULL,
    "stellarAddress" TEXT NOT NULL,
    "box" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_backup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_auth_handshake" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "provider" "WalletAuthProvider" NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "status" "WalletAuthHandshakeStatus" NOT NULL DEFAULT 'PENDING',
    "email" TEXT,
    "name" TEXT,
    "avatar" TEXT,
    "subject" TEXT,
    "failure" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallet_auth_handshake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_login_code" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatar" TEXT,
    "via" "WalletAuthMethod" NOT NULL DEFAULT 'EMAIL',
    "claimHash" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" "WalletLoginCodeStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_login_code_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_account_email_key" ON "wallet_account"("email");

-- CreateIndex
CREATE INDEX "wallet_account_stellarAddress_idx" ON "wallet_account"("stellarAddress");

-- CreateIndex
CREATE INDEX "wallet_account_consumerId_idx" ON "wallet_account"("consumerId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_backup_walletAccountId_key" ON "wallet_backup"("walletAccountId");

-- CreateIndex
CREATE INDEX "wallet_backup_stellarAddress_idx" ON "wallet_backup"("stellarAddress");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_auth_handshake_state_key" ON "wallet_auth_handshake"("state");

-- CreateIndex
CREATE INDEX "wallet_auth_handshake_status_expiresAt_idx" ON "wallet_auth_handshake"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_login_code_claimHash_key" ON "wallet_login_code"("claimHash");

-- CreateIndex
CREATE INDEX "wallet_login_code_email_idx" ON "wallet_login_code"("email");

-- CreateIndex
CREATE INDEX "wallet_login_code_status_expiresAt_idx" ON "wallet_login_code"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "wallet_account" ADD CONSTRAINT "wallet_account_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_backup" ADD CONSTRAINT "wallet_backup_walletAccountId_fkey" FOREIGN KEY ("walletAccountId") REFERENCES "wallet_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

