-- Claimable aliases: a human handle resolving to Stellar addresses, claimed by
-- proving control of a key and recoverable through email. See the block comment
-- over the models in prisma/schema.prisma for why each shape is what it is.

CREATE TYPE "AliasStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "AliasChallengePurpose" AS ENUM ('CLAIM', 'ADD_ADDRESS', 'RECOVER');

CREATE TABLE "alias" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerifiedAt" TIMESTAMP(3),
    "status" "AliasStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "alias_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "alias_address" (
    "id" TEXT NOT NULL,
    "aliasId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "label" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "alias_address_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "alias_challenge" (
    "id" TEXT NOT NULL,
    "aliasId" TEXT,
    "purpose" "AliasChallengePurpose" NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "alias_challenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "alias_recovery" (
    "id" TEXT NOT NULL,
    "aliasId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "alias_recovery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "alias_name_key" ON "alias"("name");
CREATE INDEX "alias_consumerId_idx" ON "alias"("consumerId");
CREATE INDEX "alias_email_idx" ON "alias"("email");

CREATE UNIQUE INDEX "alias_address_aliasId_network_address_key" ON "alias_address"("aliasId", "network", "address");
CREATE INDEX "alias_address_address_idx" ON "alias_address"("address");
CREATE INDEX "alias_address_aliasId_network_idx" ON "alias_address"("aliasId", "network");

-- Exactly one default address per (alias, network). A partial unique index is
-- the only way to say this: a plain unique on (aliasId, network, isPrimary)
-- would also forbid a second NON-primary address, which is the whole feature.
CREATE UNIQUE INDEX "alias_address_one_primary_per_network"
    ON "alias_address"("aliasId", "network") WHERE "isPrimary";

CREATE UNIQUE INDEX "alias_challenge_nonce_key" ON "alias_challenge"("nonce");
CREATE INDEX "alias_challenge_name_purpose_idx" ON "alias_challenge"("name", "purpose");
CREATE INDEX "alias_challenge_expiresAt_idx" ON "alias_challenge"("expiresAt");

CREATE UNIQUE INDEX "alias_recovery_tokenHash_key" ON "alias_recovery"("tokenHash");
CREATE INDEX "alias_recovery_aliasId_idx" ON "alias_recovery"("aliasId");
CREATE INDEX "alias_recovery_expiresAt_idx" ON "alias_recovery"("expiresAt");

ALTER TABLE "alias" ADD CONSTRAINT "alias_consumerId_fkey" FOREIGN KEY ("consumerId") REFERENCES "consumer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alias_address" ADD CONSTRAINT "alias_address_aliasId_fkey" FOREIGN KEY ("aliasId") REFERENCES "alias"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alias_challenge" ADD CONSTRAINT "alias_challenge_aliasId_fkey" FOREIGN KEY ("aliasId") REFERENCES "alias"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alias_recovery" ADD CONSTRAINT "alias_recovery_aliasId_fkey" FOREIGN KEY ("aliasId") REFERENCES "alias"("id") ON DELETE CASCADE ON UPDATE CASCADE;
