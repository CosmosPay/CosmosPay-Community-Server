import { randomBytes } from 'node:crypto';
import {
  atRestKeyId,
  isSealedAtRest,
  keyringFrom,
  openAtRest,
  parseAtRestKey,
  sealAtRest,
} from '@/wallet-auth/backup-cipher';

const BOX = JSON.stringify({ v: 4, iv: 'aaaa', data: 'bbbb', slots: [] });
const G = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
const b64 = () => randomBytes(32).toString('base64');

describe('backup at-rest seal', () => {
  it('round-trips, and what it stores does not contain the box', () => {
    const ring = keyringFrom(b64(), '');
    const stored = sealAtRest(BOX, 'stellar', G, ring.current!);
    expect(isSealedAtRest(stored)).toBe(true);
    expect(stored).not.toContain('slots');
    expect(openAtRest(stored, 'stellar', G, ring)).toBe(BOX);
  });

  it('uses a fresh IV per write', () => {
    const ring = keyringFrom(b64(), '');
    expect(sealAtRest(BOX, 'stellar', G, ring.current!)).not.toBe(
      sealAtRest(BOX, 'stellar', G, ring.current!),
    );
  });

  /* A box moved to another row by someone with write access must not restore there. */
  it('is bound to its row: another address or chain does not open it', () => {
    const ring = keyringFrom(b64(), '');
    const stored = sealAtRest(BOX, 'stellar', G, ring.current!);
    expect(() =>
      openAtRest(stored, 'stellar', `G${'A'.repeat(55)}`, ring),
    ).toThrow();
    expect(() => openAtRest(stored, 'solana', G, ring)).toThrow();
  });

  it('refuses a tampered row', () => {
    const ring = keyringFrom(b64(), '');
    const stored = sealAtRest(BOX, 'stellar', G, ring.current!);
    const parts = stored.split(':');
    const body = Buffer.from(parts[3], 'base64url');
    body[0] ^= 1;
    parts[3] = body.toString('base64url');
    expect(() => openAtRest(parts.join(':'), 'stellar', G, ring)).toThrow();
  });

  /* Rotation: new writes use the new key, rows written before still open. */
  it('opens rows sealed under a previous key, and not under an unknown one', () => {
    const oldKey = b64();
    const before = sealAtRest(
      BOX,
      'stellar',
      G,
      keyringFrom(oldKey, '').current!,
    );

    const rotated = keyringFrom(b64(), oldKey);
    expect(openAtRest(before, 'stellar', G, rotated)).toBe(BOX);
    expect(() =>
      openAtRest(before, 'stellar', G, keyringFrom(b64(), '')),
    ).toThrow(/no configured key/);
  });

  it('reads a row written before the seal existed as it is', () => {
    expect(openAtRest(BOX, 'stellar', G, keyringFrom(b64(), ''))).toBe(BOX);
  });

  it('parses a key in base64, base64url or hex, and nothing shorter', () => {
    const raw = randomBytes(32);
    expect(parseAtRestKey(raw.toString('base64'))).toEqual(raw);
    expect(parseAtRestKey(raw.toString('base64url'))).toEqual(raw);
    expect(parseAtRestKey(raw.toString('hex'))).toEqual(raw);
    expect(parseAtRestKey(randomBytes(16).toString('base64'))).toBeNull();
    expect(() => keyringFrom('not-a-key', '')).toThrow(
      /WALLET_BACKUP_ENCRYPTION_KEY/,
    );
    expect(keyringFrom(raw.toString('hex'), '').current?.id).toBe(
      atRestKeyId(raw),
    );
  });
});
