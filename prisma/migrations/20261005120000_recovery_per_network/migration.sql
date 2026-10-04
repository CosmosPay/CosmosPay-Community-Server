-- A recovery server now serves more than one ledger. A signer is an entry on ONE
-- ledger, so the same address registered on testnet and on mainnet is two
-- registrations: the unique key gains the network.

-- DropIndex
DROP INDEX "recovery_account_role_address_key";

-- CreateIndex
CREATE UNIQUE INDEX "recovery_account_role_network_address_key" ON "recovery_account"("role", "network", "address");
