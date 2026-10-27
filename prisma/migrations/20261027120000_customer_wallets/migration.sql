-- A customer has any number of wallets, on Stellar, Solana or Monad, instead of one `account`.
-- A wallet belongs to one customer of a merchant (unique per consumer, chain and address).
CREATE TABLE "customer_wallet" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_wallet_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "customer_wallet_customerId_idx" ON "customer_wallet"("customerId");

CREATE UNIQUE INDEX "customer_wallet_consumerId_chain_address_key" ON "customer_wallet"("consumerId", "chain", "address");

ALTER TABLE "customer_wallet" ADD CONSTRAINT "customer_wallet_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every stored account becomes its customer's first wallet, on the chain its shape names (the
-- three shapes do not overlap; a Monad account is already stored EIP-55). When two customers of
-- one merchant held the same account, the older one keeps it.
INSERT INTO "customer_wallet" ("id", "consumerId", "customerId", "chain", "address", "createdAt")
SELECT DISTINCT ON (c."consumerId", s."chain", c."account")
       'cw' || md5(c."id" || ':' || c."account"), c."consumerId", c."id", s."chain", c."account", c."createdAt"
  FROM "customer" c
  CROSS JOIN LATERAL (
    SELECT CASE
             WHEN c."account" ~ '^G[A-Z2-7]{55}$' THEN 'stellar'
             WHEN c."account" ~ '^0x[0-9a-fA-F]{40}$' THEN 'monad'
             WHEN c."account" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN 'solana'
           END AS "chain"
  ) s
 WHERE c."account" IS NOT NULL
   AND s."chain" IS NOT NULL
 ORDER BY c."consumerId", s."chain", c."account", c."createdAt";

-- An account that could not move (no chain's shape, or an older customer already holds it) is
-- kept in the customer's note rather than lost with the column.
UPDATE "customer" c
   SET "note" = concat_ws(E'\n', c."note", 'Previous account: ' || c."account")
 WHERE c."account" IS NOT NULL
   AND c."account" <> ''
   AND NOT EXISTS (SELECT 1 FROM "customer_wallet" w WHERE w."customerId" = c."id");

ALTER TABLE "customer" DROP COLUMN "account";
