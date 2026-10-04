-- One backup per WALLET, not per account: a sign-in on a new device restores every
-- wallet the person backed up. Existing rows keep their (account, chain, address),
-- which is already unique since an account held at most one row.

-- DropIndex
DROP INDEX "wallet_backup_walletAccountId_key";

-- CreateIndex
CREATE UNIQUE INDEX "wallet_backup_walletAccountId_chain_stellarAddress_key" ON "wallet_backup"("walletAccountId", "chain", "stellarAddress");
