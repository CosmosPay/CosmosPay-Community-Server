import { createSign, generateKeyPairSync } from 'node:crypto';
import {
  readWebhookJwks,
  webhookBodyHash,
  webhookHashMatches,
  webhookSignatureVerifies,
  webhookSignedByAny,
} from '@/native-plugins/eldorado/p2p-webhook-signature';

/** A marketplace key pair, made here: no test reads a real key or the network. */
function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  return {
    privateKey,
    publicKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' },
  };
}

/** How the marketplace signs: RSA-SHA256 over the HEX string of sha256(body), base64. */
function sign(
  body: string,
  privateKey: ReturnType<typeof keyPair>['privateKey'],
) {
  const hash = webhookBodyHash(Buffer.from(body));
  const signature = createSign('RSA-SHA256')
    .update(hash)
    .sign(privateKey, 'base64');
  return { hash, signature };
}

describe('P2P webhook signature', () => {
  const marketplace = keyPair();
  const stranger = keyPair();
  const body = JSON.stringify({ order: { orderStatus: 'COMPLETED' } });

  it('hashes the raw body as lowercase sha256 hex, compared exactly', () => {
    const raw = Buffer.from(body);
    const { hash } = sign(body, marketplace.privateKey);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(webhookHashMatches(raw, hash)).toBe(true);
    // A body changed by one byte, or a hash that is not this body's.
    expect(webhookHashMatches(Buffer.from(`${body} `), hash)).toBe(false);
    expect(webhookHashMatches(raw, '0'.repeat(64))).toBe(false);
    expect(webhookHashMatches(raw, undefined)).toBe(false);
    expect(webhookHashMatches(raw, '')).toBe(false);
  });

  it('verifies a signature of the hash hex by the marketplace’s key', () => {
    const [key] = readWebhookJwks({ keys: [marketplace.jwk] });
    const { hash, signature } = sign(body, marketplace.privateKey);

    expect(webhookSignatureVerifies(hash, signature, key)).toBe(true);
  });

  it('refuses a tampered body, another key’s signature and a malformed one', () => {
    const [key] = readWebhookJwks({ keys: [marketplace.jwk] });
    const { hash, signature } = sign(body, marketplace.privateKey);
    const forged = sign(body, stranger.privateKey);
    const tampered = webhookBodyHash(
      Buffer.from(body.replace('COMPLETED', 'CANCELLED')),
    );

    // The signature is over the original body's hash, not the tampered one's.
    expect(webhookSignatureVerifies(tampered, signature, key)).toBe(false);
    expect(webhookSignatureVerifies(hash, forged.signature, key)).toBe(false);
    for (const bad of ['', 'not base64!', 'A'.repeat(2000)]) {
      expect(webhookSignatureVerifies(hash, bad, key)).toBe(false);
    }
    // One flipped character of a good signature.
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    expect(webhookSignatureVerifies(hash, flipped, key)).toBe(false);
  });

  it('tries every key of the set, the first first', () => {
    const keys = readWebhookJwks({ keys: [stranger.jwk, marketplace.jwk] });
    const { hash, signature } = sign(body, marketplace.privateKey);

    expect(keys).toHaveLength(2);
    expect(webhookSignedByAny(hash, signature, keys)).toBe(true);
    expect(webhookSignedByAny(hash, signature, keys.slice(0, 1))).toBe(false);
    expect(webhookSignedByAny(hash, signature, [])).toBe(false);
  });

  it('reads only the RSA signing keys of a JWKS', () => {
    const { n, e } = marketplace.jwk as { n: string; e: string };

    expect(
      readWebhookJwks({
        keys: [
          { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
          { kty: 'RSA', use: 'enc', n, e },
          { kty: 'RSA', n: 'not-a-modulus', e: 1 },
          null,
          { kty: 'RSA', alg: 'RS256', n, e },
        ],
      }),
    ).toHaveLength(1);
    expect(readWebhookJwks(null)).toEqual([]);
    expect(readWebhookJwks({ keys: 'nope' })).toEqual([]);
  });
});
