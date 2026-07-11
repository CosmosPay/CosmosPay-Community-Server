import {
  computeSvixSignature,
  verifySvixSignature,
} from './blindpay-signature';

describe('verifySvixSignature', () => {
  const secret = `whsec_${Buffer.from('a-32-byte-or-so-secret-key-value').toString('base64')}`;
  const id = 'msg_2abc';
  const body = JSON.stringify({ type: 'payin.complete', data: { id: 'pi_1' } });

  const now = () => Math.floor(Date.now() / 1000);

  function headers(ts: number, sig?: string) {
    const signature = sig ?? computeSvixSignature(secret, id, String(ts), body);
    return { id, timestamp: String(ts), signature: `v1,${signature}` };
  }

  it('accepts a correctly signed, fresh payload', () => {
    expect(verifySvixSignature(secret, body, headers(now()))).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifySvixSignature(secret, `${body} `, headers(now()))).toBe(false);
  });

  it('rejects a forged signature', () => {
    expect(verifySvixSignature(secret, body, headers(now(), 'deadbeef'))).toBe(
      false,
    );
  });

  it('rejects a replayed (stale) timestamp', () => {
    expect(verifySvixSignature(secret, body, headers(now() - 10 * 60))).toBe(
      false,
    );
  });

  it('accepts when any of several offered signatures matches', () => {
    const ts = now();
    const good = computeSvixSignature(secret, id, String(ts), body);
    const sig = `v2,ignored v1,bad v1,${good}`;
    expect(
      verifySvixSignature(secret, body, {
        id,
        timestamp: String(ts),
        signature: sig,
      }),
    ).toBe(true);
  });

  it('rejects when headers are missing', () => {
    expect(
      verifySvixSignature(secret, body, {
        id: '',
        timestamp: '',
        signature: '',
      }),
    ).toBe(false);
  });

  it('rejects when signed with a different secret', () => {
    const otherHeaders = {
      id,
      timestamp: String(now()),
      signature: `v1,${computeSvixSignature('whsec_AAAA', id, String(now()), body)}`,
    };
    expect(verifySvixSignature(secret, body, otherHeaders)).toBe(false);
  });
});
