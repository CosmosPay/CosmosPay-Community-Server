import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { AliasChallengePurpose } from '@generated/prisma/client';
import {
  ALIAS_SIGN_DOMAIN,
  aliasChallengeMessage,
  aliasDigest,
  isStellarAddress,
  verifyAliasSignature,
  type AliasChallengeBody,
} from '@/aliases/alias-signing';

/**
 * The signature is the entire reason an alias can be trusted. These assert the two
 * properties that make it worth anything: it proves the address, and it can never
 * be spent as something else.
 */
describe('alias signing', () => {
  const kp = Keypair.random();
  // Typed, not inferred: without the annotation `purpose` narrows to the literal
  // `'CLAIM'` and the replay test below cannot even be written.
  const body: AliasChallengeBody = {
    purpose: AliasChallengePurpose.CLAIM,
    name: 'emanuel250',
    address: kp.publicKey(),
    network: 'public',
    nonce: 'nonce-1',
  };

  // `Keypair.sign` returns a Uint8Array in SDK v17, not a Buffer, so it is wrapped
  // rather than having `.toString('base64')` called on it directly.
  const sign = (b: AliasChallengeBody, signer: Keypair = kp) =>
    Buffer.from(signer.sign(aliasDigest(aliasChallengeMessage(b)))).toString(
      'base64',
    );

  it('verifies a signature from the claiming address', () => {
    expect(verifyAliasSignature(body, sign(body))).toBe(true);
  });

  it('refuses a signature from any other key', () => {
    // Without this an alias could be pointed at an account whose owner never
    // participated — a directory anyone can poison.
    const impostor = Keypair.random();
    expect(verifyAliasSignature(body, sign(body, impostor))).toBe(false);
  });

  it('commits to every field, so nothing can be swapped after signing', () => {
    const sig = sign(body);
    const tampered: AliasChallengeBody[] = [
      { ...body, name: 'someone_else' },
      { ...body, address: Keypair.random().publicKey() },
      { ...body, network: 'testnet' },
      { ...body, nonce: 'nonce-2' },
      { ...body, purpose: AliasChallengePurpose.RECOVER },
    ];
    for (const t of tampered) {
      expect(verifyAliasSignature(t, sig)).toBe(false);
    }
  });

  it('cannot replay an ADD_ADDRESS signature into a RECOVER', () => {
    // The purpose is inside the signed bytes precisely for this: adding an address
    // is routine and low-stakes, completing a recovery hands over the whole alias.
    const add: AliasChallengeBody = {
      ...body,
      purpose: AliasChallengePurpose.ADD_ADDRESS,
    };
    const sig = sign(add);
    expect(verifyAliasSignature(add, sig)).toBe(true);
    expect(
      verifyAliasSignature(
        { ...add, purpose: AliasChallengePurpose.RECOVER },
        sig,
      ),
    ).toBe(false);
  });

  it('frames the digest unambiguously', () => {
    // Without the 0x00 separator and the explicit length, domain="A" msg="BC" and
    // domain="AB" msg="C" would hash the same — and a challenge for one purpose
    // could be presented as another.
    expect(aliasDigest('a')).toHaveLength(32);
    expect(aliasDigest('a')).not.toEqual(aliasDigest('b'));
    expect(aliasChallengeMessage(body).split('\n')).toEqual([
      `domain: ${ALIAS_SIGN_DOMAIN}`,
      'purpose: CLAIM',
      'alias: emanuel250',
      `address: ${kp.publicKey()}`,
      'network: public',
      'nonce: nonce-1',
    ]);
  });

  it('what it signs can never be a transaction signature', () => {
    // The reason a claim asks for a signature rather than a transaction. A signed
    // envelope is a submittable envelope unless something guarantees otherwise;
    // this guarantees it by construction rather than by a sequence number nobody
    // re-checks after the next refactor.
    const tx = new TransactionBuilder(new Account(kp.publicKey(), '1'), {
      fee: BASE_FEE,
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: '1000',
        }),
      )
      .setTimeout(60)
      .build();

    const claimSig = Buffer.from(sign(body), 'base64');
    expect(kp.verify(tx.hash(), claimSig)).toBe(false);

    // ...and a transaction signature must not pass as a claim. In SDK v17
    // `.signature` is an XDR wrapper, so the raw 64 bytes come off `.value`.
    tx.sign(kp);
    const txSig = Buffer.from(tx.signatures[0].signature.value).toString(
      'base64',
    );
    expect(kp.verify(tx.hash(), Buffer.from(txSig, 'base64'))).toBe(true);
    expect(verifyAliasSignature(body, txSig)).toBe(false);
  });

  it('refuses junk instead of throwing', () => {
    // Every input arrives from the wire. A verifier that crashes on bad input is a
    // denial of service on the claim endpoint.
    expect(verifyAliasSignature(body, 'not base64 !!!')).toBe(false);
    expect(verifyAliasSignature(body, '')).toBe(false);
    expect(
      verifyAliasSignature(body, Buffer.alloc(10).toString('base64')),
    ).toBe(false);
    expect(verifyAliasSignature({ ...body, address: 'nope' }, sign(body))).toBe(
      false,
    );
  });

  it('recognises a Stellar address', () => {
    expect(isStellarAddress(kp.publicKey())).toBe(true);
    expect(isStellarAddress(kp.secret())).toBe(false);
    expect(isStellarAddress('GA')).toBe(false);
  });
});
