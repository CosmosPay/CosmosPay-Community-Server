-- AlterEnum
ALTER TYPE "WalletAuthMethod" ADD VALUE 'AUTHENTIK';

-- AlterEnum
ALTER TYPE "WalletAuthProvider" ADD VALUE 'AUTHENTIK';

-- AlterTable
ALTER TABLE "wallet_auth_handshake" ADD COLUMN "providerVerifier" TEXT,
ADD COLUMN "nonce" TEXT,
ADD COLUMN "idToken" TEXT;

-- AlterTable
ALTER TABLE "wallet_login_code" ADD COLUMN "idToken" TEXT;

-- CreateEnum
CREATE TYPE "RecoveryEmailCodeStatus" AS ENUM ('PENDING', 'CLAIMED', 'LOCKED', 'EXPIRED');

-- CreateTable
CREATE TABLE "recovery_account" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recovery_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_auth_method" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "identityRole" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_auth_method_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_email_code" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "claimHash" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" "RecoveryEmailCodeStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_email_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recovery_used_id_token" (
    "id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recovery_used_id_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recovery_account_role_address_key" ON "recovery_account"("role", "address");

-- CreateIndex
CREATE INDEX "recovery_auth_method_accountId_idx" ON "recovery_auth_method"("accountId");

-- CreateIndex
CREATE INDEX "recovery_auth_method_type_value_idx" ON "recovery_auth_method"("type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_email_code_claimHash_key" ON "recovery_email_code"("claimHash");

-- CreateIndex
CREATE INDEX "recovery_email_code_role_email_idx" ON "recovery_email_code"("role", "email");

-- CreateIndex
CREATE INDEX "recovery_email_code_status_expiresAt_idx" ON "recovery_email_code"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_used_id_token_role_tokenHash_key" ON "recovery_used_id_token"("role", "tokenHash");

-- CreateIndex
CREATE INDEX "recovery_used_id_token_expiresAt_idx" ON "recovery_used_id_token"("expiresAt");

-- AddForeignKey
ALTER TABLE "recovery_auth_method" ADD CONSTRAINT "recovery_auth_method_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "recovery_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
