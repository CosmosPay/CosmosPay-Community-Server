import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { cannotHaveSettled, storedEnvelope } from '@/stellar/stored-envelope';

const PASSPHRASE = Networks.TESTNET;
const SIGNER = Keypair.random();

/** An unsigned envelope built from an account at `sequence`. */
function envelopeAt(sequence: string) {
  const account = new Account(SIGNER.publicKey(), sequence);
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: '1',
      }),
    )
    .setTimeout(300)
    .build();
}

describe('storedEnvelope', () => {
  it('reads back an envelope this service built', () => {
    const tx = envelopeAt('7');
    const parsed = storedEnvelope(tx.toXDR(), PASSPHRASE);

    // Built from sequence 7, so the transaction consumes 8.
    expect(parsed?.sequence).toBe('8');
  });

  it('is null for bytes that do not parse', () => {
    expect(storedEnvelope('not-an-envelope', PASSPHRASE)).toBeNull();
    expect(storedEnvelope('', PASSPHRASE)).toBeNull();
  });

  it('is null for a fee bump, whose sequence belongs to the fee account', () => {
    const inner = envelopeAt('7');
    inner.sign(SIGNER);
    const bumped = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random(),
      '2000',
      inner,
      PASSPHRASE,
    );

    expect(storedEnvelope(bumped.toXDR(), PASSPHRASE)).toBeNull();
  });
});

describe('cannotHaveSettled', () => {
  it('is true while the account has not reached the sequence the row holds', () => {
    // Built at 7 → consumes 8; the account is still at 7, so the row is not
    // on-chain and the next build takes 8 as well.
    expect(cannotHaveSettled(envelopeAt('7').toXDR(), PASSPHRASE, '7')).toBe(
      true,
    );
  });

  it('is false once the account has consumed that number', () => {
    expect(cannotHaveSettled(envelopeAt('7').toXDR(), PASSPHRASE, '8')).toBe(
      false,
    );
    expect(cannotHaveSettled(envelopeAt('7').toXDR(), PASSPHRASE, '12')).toBe(
      false,
    );
  });

  it('is false for an envelope it cannot read: nothing about the row is known', () => {
    expect(cannotHaveSettled('not-an-envelope', PASSPHRASE, '7')).toBe(false);
  });

  it('compares numbers too large for a double', () => {
    // Stellar sequence numbers are int64: ledger-derived starts are already
    // past 2^53, where `Number` stops counting one at a time.
    const big = '4503599627370496';
    const next = '4503599627370497';
    expect(cannotHaveSettled(envelopeAt(big).toXDR(), PASSPHRASE, big)).toBe(
      true,
    );
    expect(cannotHaveSettled(envelopeAt(big).toXDR(), PASSPHRASE, next)).toBe(
      false,
    );
  });
});
