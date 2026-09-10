import { createHash } from 'node:crypto';
import { Keypair } from '@stellar/stellar-sdk';
import { AliasChallengePurpose } from '@generated/prisma/client';

/**
 * The bytes a claimant signs, and how this service checks them.
 *
 * ## Why a digest and not a transaction
 *
 * The obvious way to prove control of a Stellar key is to make the holder sign a
 * transaction. It is also the wrong way, and the wallet already refuses to do it
 * (see its `src/lib/signMessage.ts`): a signed envelope is a submittable envelope
 * unless something guarantees otherwise, and "something" would be a sequence
 * number nobody re-checks after the next refactor.
 *
 * So the claimant signs SHA-256 over a domain prefix, a length and a body. A
 * transaction signature is ed25519 over the 32-byte transaction hash; producing a
 * digest here that equals a chosen transaction hash needs a preimage attack. The
 * consequence that matters: no signature this service ever asks for can move
 * money, whatever a caller sends.
 *
 * ## The framing must match the wallet byte for byte
 *
 * `payload = domain || 0x00 || uint32be(byteLength) || message`, then SHA-256.
 * The wallet's `signMessagePayload` builds exactly this. The `0x00` separator and
 * the explicit length are not decoration — without them `domain="A", msg="BC"`
 * and `domain="AB", msg="C"` hash the same, and a challenge for one purpose could
 * be presented as another.
 *
 * ## The domain is this feature's own
 *
 * Never the wallet's `signMessage` tag, and never its diagnostics-attestation
 * tag. A dapp can ask a user to sign an arbitrary string through the approval
 * window; if the tags were shared it would ask for a well-formed alias claim and
 * get one, and the alias would be pointed at the attacker's account by a
 * signature the real owner produced.
 */
export const ALIAS_SIGN_DOMAIN = 'Cosmos Pay alias claim v1';

/** Everything the signature commits to. Every field is load-bearing. */
export interface AliasChallengeBody {
  purpose: AliasChallengePurpose;
  /** Normalized handle. */
  name: string;
  address: string;
  network: string;
  nonce: string;
}

/**
 * The exact string that gets digested.
 *
 * Fixed order, `key: value`, newline-separated, no optional fields. A builder that
 * omitted one would produce a shorter string that still parses, and two different
 * claims must never digest the same.
 *
 * `purpose` is inside the signed bytes and that is the point of it existing: a
 * signature collected for `ADD_ADDRESS` — a low-stakes action the owner performs
 * routinely — would otherwise be replayable to complete a `RECOVER`, which hands
 * the whole alias to whoever presents it.
 */
export function aliasChallengeMessage(body: AliasChallengeBody): string {
  return [
    `domain: ${ALIAS_SIGN_DOMAIN}`,
    `purpose: ${body.purpose}`,
    `alias: ${body.name}`,
    `address: ${body.address}`,
    `network: ${body.network}`,
    `nonce: ${body.nonce}`,
  ].join('\n');
}

/** The 32-byte digest for `message`, framed as the wallet frames it. */
export function aliasDigest(message: string): Buffer {
  const domain = Buffer.from(ALIAS_SIGN_DOMAIN, 'utf8');
  const body = Buffer.from(message, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  return createHash('sha256')
    .update(Buffer.concat([domain, Buffer.from([0x00]), len, body]))
    .digest();
}

/**
 * Does `signature` prove that `body.address` produced it?
 *
 * Returns a boolean and never throws. Every input here arrives from the wire: a
 * malformed address, a base64 that is not a signature, a nonce with the wrong
 * shape. Each of those is a refusal, not a 500 — a verifier that crashes on bad
 * input is a denial-of-service on the claim endpoint.
 */
export function verifyAliasSignature(
  body: AliasChallengeBody,
  signatureBase64: string,
): boolean {
  try {
    const digest = aliasDigest(aliasChallengeMessage(body));
    const sig = Buffer.from(signatureBase64, 'base64');
    // A wrong-length buffer is what `Buffer.from(…, 'base64')` silently produces
    // from junk input, and the SDK would throw on it rather than return false.
    if (sig.length !== 64) return false;
    return Keypair.fromPublicKey(body.address).verify(digest, sig);
  } catch {
    return false;
  }
}

/** Is `value` a syntactically valid Stellar account id? */
export function isStellarAddress(value: string): boolean {
  try {
    Keypair.fromPublicKey(value);
    return true;
  } catch {
    return false;
  }
}
