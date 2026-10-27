-- A Monad deposit address with a merchant fee is a PaymentSplitForwarder: its fee wallet and
-- amount are constructor arguments. Null on every existing row (a PaymentForwarder).
ALTER TABLE "evm_deposit_address" ADD COLUMN "feeWallet" TEXT;
ALTER TABLE "evm_deposit_address" ADD COLUMN "merchantFee" TEXT;
