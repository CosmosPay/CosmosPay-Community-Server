-- A private payment with a merchant fee settles with a third confidential transfer, to the
-- fee's wallet. Null on every existing row (none has a merchant fee).
ALTER TABLE "zk_payment" ADD COLUMN "merchantFeeTxHash" TEXT;

-- One transaction settles at most one private payment, as for the other two hashes.
CREATE UNIQUE INDEX "zk_payment_merchantFeeTxHash_key" ON "zk_payment"("merchantFeeTxHash");
