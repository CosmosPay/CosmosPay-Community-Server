-- Cost-basis capture for liquidity pool deposits: the shares minted and the
-- actual reserves deposited, read from the on-chain effect once a deposit
-- settles. Withdrawals leave these null; they feed the withdraw commission
-- (charged only on the gain over the deposited principal).
-- AlterTable
ALTER TABLE "liquidity_pool_operation" ADD COLUMN "sharesReceived" TEXT;
ALTER TABLE "liquidity_pool_operation" ADD COLUMN "settledAmountA" TEXT;
ALTER TABLE "liquidity_pool_operation" ADD COLUMN "settledAmountB" TEXT;
