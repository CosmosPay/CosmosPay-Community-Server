import {
  Account,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import {
  RECOVERY_DEVICE_WEIGHT,
  RECOVERY_SERVER_WEIGHT,
  RECOVERY_SETUP_TIMEOUT_S,
} from '@/wallet-auth/wallet-auth.constants';

/**
 * The transaction that puts the two recovery signers on an account, in the
 * variant the account cannot pay for itself: the operator sponsors the two
 * signer entries' reserve (0.5 XLM each), which is the only way an account with
 * no spare lumens gets recovery at all.
 *
 *   device (10)            ≥ threshold (10)  → normal use needs nobody else
 *   server a (5) + b (5)   ≥ threshold (10)  → recovery needs BOTH servers
 *   one server alone (5)   <  threshold (10) → one server can do nothing
 *
 * The account's own signature is ALWAYS missing: the wallet adds it only after
 * its guard has matched every operation against its `recovery` template. A
 * transaction this returned ready to submit would be one nothing on the device
 * ever read.
 *
 * Served from the MAIN deployment, never from a recovery server: the sponsor key
 * is the operator's money, and the two recovery servers are the two hosts that
 * must not also be able to spend it (`identity-env.ts` refuses the combination).
 */
export interface SponsoredSetupInput {
  account: string;
  signers: readonly [string, string];
  networkPassphrase: string;
  /** Current sequence of `account`, from Horizon. */
  sequence: string;
  sponsor: Keypair;
}

export function buildSponsoredRecoverySetup(
  input: SponsoredSetupInput,
): string {
  const source = new Account(input.account, input.sequence);
  const builder = new TransactionBuilder(source, {
    fee: String(Number(BASE_FEE) * 5),
    networkPassphrase: input.networkPassphrase,
    memo: Memo.none(),
  }).addOperation(
    Operation.beginSponsoringFutureReserves({
      sponsoredId: input.account,
      source: input.sponsor.publicKey(),
    }),
  );
  for (const key of input.signers) {
    builder.addOperation(
      Operation.setOptions({
        source: input.account,
        signer: { ed25519PublicKey: key, weight: RECOVERY_SERVER_WEIGHT },
      }),
    );
  }
  builder
    .addOperation(
      Operation.endSponsoringFutureReserves({ source: input.account }),
    )
    // Last: with the signers in place, the account's rule for "enough" rises to
    // a number the two servers together reach and neither reaches alone.
    .addOperation(
      Operation.setOptions({
        source: input.account,
        masterWeight: RECOVERY_DEVICE_WEIGHT,
        lowThreshold: RECOVERY_DEVICE_WEIGHT,
        medThreshold: RECOVERY_DEVICE_WEIGHT,
        highThreshold: RECOVERY_DEVICE_WEIGHT,
      }),
    );

  const tx = builder.setTimeout(RECOVERY_SETUP_TIMEOUT_S).build();
  tx.sign(input.sponsor);
  return tx.toXDR();
}
