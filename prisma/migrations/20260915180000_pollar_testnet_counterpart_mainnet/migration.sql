-- A testnet login no longer provisions its user a mainnet wallet: testnet is where
-- `dev` keys land, and a key anyone can mint for free must not spend the operator's
-- real XLM on a mainnet reserve per login (see POLLAR_COUNTERPART_NETWORK).
--
-- The mainnet counterpart rows those logins already left PENDING would still be
-- provisioned by the sweeper, so they are closed here. A counterpart row is created
-- with neither an address nor a Pollar user id, while a mainnet login's own deferred
-- wallet records the user id the login returned, which is what tells them apart.
-- Data only: no schema change, no table rewrite, nothing deleted.
UPDATE "pollar_user_wallet"
SET "status" = 'FAILED',
    "errorCode" = 'COUNTERPART_FROM_TESTNET_DISABLED',
    "nextAttemptAt" = NULL
WHERE "network" = 'public'
  AND "status" = 'PENDING'
  AND "address" IS NULL
  AND "pollarUserId" IS NULL;
