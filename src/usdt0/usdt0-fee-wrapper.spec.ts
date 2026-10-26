import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { USDT0_FEE_WRAPPER_WASM_SHA256 } from '@/usdt0/usdt0.constants';

const CRATE = join(
  __dirname,
  '..',
  '..',
  'contracts',
  'soroban',
  'usdt0-fee-wrapper',
);

describe('the USDT0 fee wrapper', () => {
  it('pins the hash of the committed wasm, the one a deployment must run', () => {
    const wasm = readFileSync(join(CRATE, 'usdt0_fee_wrapper.wasm'));
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(
      USDT0_FEE_WRAPPER_WASM_SHA256,
    );
  });

  it('is built from the source beside it', () => {
    const source = readFileSync(join(CRATE, 'src', 'lib.rs'), 'utf8');
    // The entry points the service calls, and the OFT call it forwards.
    for (const needle of [
      'pub fn send(',
      'pub fn oft(',
      'pub fn token(',
      'from.require_auth()',
      'Symbol::new(&env, "send")',
    ]) {
      expect(source).toContain(needle);
    }
  });
});
