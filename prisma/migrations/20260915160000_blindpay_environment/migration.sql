-- Every BlindPay mirror row records which platform instance it belongs to.
--
-- The service used one BlindPay instance for every API key, so a `dev` key could
-- list, delete and pay out against production receivers. It now talks to one
-- instance per key environment, and because a tenant's dev and prod keys resolve
-- to the same consumer, the rows themselves must say which instance they
-- describe for reads to stay apart.
--
-- Existing rows are labelled 'prod': they were created against the instance the
-- unsuffixed BLINDPAY_* variables point at, which is the production instance
-- from this release on. A deployment whose BLINDPAY_* pointed at a development
-- instance must relabel them — see the README's upgrade notes.
--
-- A constant default makes each ADD COLUMN a catalog-only change on PostgreSQL
-- 11+: no table rewrite, only a brief exclusive lock per table.

-- AlterTable
ALTER TABLE "blindpay_receiver" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'prod';

-- AlterTable
ALTER TABLE "blindpay_blockchain_wallet" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'prod';

-- AlterTable
ALTER TABLE "blindpay_bank_account" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'prod';

-- AlterTable
ALTER TABLE "blindpay_virtual_account" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'prod';

-- AlterTable
ALTER TABLE "payin" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'prod';

-- AlterTable
ALTER TABLE "payout" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'prod';

-- AlterTable
ALTER TABLE "blindpay_quote" ADD COLUMN "environment" TEXT NOT NULL DEFAULT 'prod';
