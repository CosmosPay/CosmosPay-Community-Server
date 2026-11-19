import { ConfigService } from '@nestjs/config';
import { P2pDataCipher } from '@/p2p/p2p-data-cipher';

function cipher(key: string): P2pDataCipher {
  const config = {
    get: () => ({ dataEncryptionKey: key }),
  } as unknown as ConfigService<never, true>;
  return new P2pDataCipher(config);
}

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('P2P data cipher', () => {
  it('seals and opens a value for the row and field it belongs to', () => {
    const c = cipher(KEY);
    const sealed = c.seal('order.payer', 'row-1', {
      name: 'Juan',
      document: '123',
    });
    expect(sealed.startsWith('enc1:')).toBe(true);
    expect(sealed).not.toContain('Juan');
    expect(c.open('order.payer', 'row-1', sealed)).toEqual({
      name: 'Juan',
      document: '123',
    });
  });

  it('refuses a value moved to another row or another field', () => {
    const c = cipher(KEY);
    const sealed = c.seal('order.payer', 'row-1', { name: 'Juan' });
    expect(() => c.open('order.payer', 'row-2', sealed)).toThrow();
    expect(() => c.open('order.beneficiary', 'row-1', sealed)).toThrow();
  });

  it('refuses a plain value: every P2P value is written sealed', () => {
    expect(() =>
      cipher(KEY).open('order.payer', 'row-1', JSON.stringify({ name: 'x' })),
    ).toThrow('is not sealed');
  });

  it('answers 503 misconfigured with no key, naming no setting', () => {
    try {
      cipher('').seal('order.payer', 'row-1', {});
      throw new Error('sealed without a key');
    } catch (err) {
      expect((err as { getStatus(): number }).getStatus()).toBe(503);
      expect(String((err as Error).message)).not.toContain('P2P_DATA');
    }
  });
});
