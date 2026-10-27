-- Cosmos Pay's plan commission on a USDT0 transfer, paid by the fee wrapper. Existing rows
-- charged none: 0 bps, "0", no wallet.
ALTER TABLE "usdt0_transfer" ADD COLUMN "feeBps" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "usdt0_transfer" ADD COLUMN "feeAmount" TEXT NOT NULL DEFAULT '0';
ALTER TABLE "usdt0_transfer" ADD COLUMN "feeWallet" TEXT;
