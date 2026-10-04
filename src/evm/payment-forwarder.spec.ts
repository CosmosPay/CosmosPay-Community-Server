import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAYMENT_FORWARDER_ARTIFACT } from '@/evm/payment-forwarder.artifact';
import {
  create2Address,
  deployCalldata,
  depositAddress,
  flushTokenCalldata,
  forwarderInitCode,
} from '@/evm/payment-forwarder';

const TERMS = {
  destination: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  token: null,
  relayer: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
  fee: 10n ** 16n,
};
const SALT = `0x${'11'.repeat(32)}`;
const ZERO_SALT = `0x${'0'.repeat(64)}`;

describe('CREATE2 (EIP-1014 vectors)', () => {
  it.each([
    [
      '0x0000000000000000000000000000000000000000',
      ZERO_SALT,
      '0x00',
      '0x4D1A2e2bB4F88F0250f26Ffff098B0b30B26BF38',
    ],
    [
      '0xdeadbeef00000000000000000000000000000000',
      ZERO_SALT,
      '0x00',
      '0xB928f69Bb1D91Cd65274e3c79d8986362984fDA3',
    ],
    [
      '0x00000000000000000000000000000000deadbeef',
      `0x${'0'.repeat(56)}cafebabe`,
      '0xdeadbeef',
      '0x60f3f640a8508fC6a86d45DF051962668E1e8AC7',
    ],
    [
      '0x0000000000000000000000000000000000000000',
      ZERO_SALT,
      '0x',
      '0xE33C0C7F7df4809055C3ebA6c09CFe4BaF1BD9e0',
    ],
  ])('deployer %s', (deployer, salt, initCode, expected) => {
    expect(create2Address(deployer, salt, initCode)).toBe(expected);
  });
});

describe('deposit addresses', () => {
  it('commit to every term: changing any one moves the address', () => {
    const base = depositAddress(SALT, forwarderInitCode(TERMS));
    for (const changed of [
      { ...TERMS, destination: TERMS.relayer },
      { ...TERMS, token: TERMS.relayer },
      { ...TERMS, relayer: TERMS.destination },
      { ...TERMS, fee: TERMS.fee + 1n },
    ]) {
      expect(depositAddress(SALT, forwarderInitCode(changed))).not.toBe(base);
    }
    expect(
      depositAddress(`0x${'22'.repeat(32)}`, forwarderInitCode(TERMS)),
    ).not.toBe(base);
  });

  it('append the four constructor words to the creation code', () => {
    const init = forwarderInitCode(TERMS);
    expect(init.startsWith(PAYMENT_FORWARDER_ARTIFACT.bytecode)).toBe(true);
    expect(init.length - PAYMENT_FORWARDER_ARTIFACT.bytecode.length).toBe(
      4 * 64,
    );
    expect(init.endsWith((10n ** 16n).toString(16).padStart(64, '0'))).toBe(
      true,
    );
  });

  it('call the proxy with salt ++ init code, and flushToken by its selector', () => {
    const init = forwarderInitCode(TERMS);
    expect(deployCalldata(SALT, init)).toBe(
      `0x${'11'.repeat(32)}${init.slice(2)}`,
    );
    expect(flushTokenCalldata(TERMS.destination)).toBe(
      `0x9cee789f${'0'.repeat(24)}${TERMS.destination.slice(2).toLowerCase()}`,
    );
  });
});

describe('PaymentForwarder artifact', () => {
  it('is the committed source, compiled with the recorded settings', () => {
    const source = readFileSync(
      join(__dirname, '..', '..', 'contracts', 'PaymentForwarder.sol'),
      'utf8',
    );
    expect(createHash('sha256').update(source).digest('hex')).toBe(
      PAYMENT_FORWARDER_ARTIFACT.sourceSha256,
    );
    // solc-js ships no types; its surface here is two functions.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const solc = require('solc') as {
      version(): string;
      compile(input: string): string;
    };
    expect(solc.version()).toBe(PAYMENT_FORWARDER_ARTIFACT.compiler);
    const out = JSON.parse(
      solc.compile(
        JSON.stringify({
          language: 'Solidity',
          sources: { 'PaymentForwarder.sol': { content: source } },
          settings: PAYMENT_FORWARDER_ARTIFACT.settings,
        }),
      ),
    );
    expect(
      `0x${out.contracts['PaymentForwarder.sol'].PaymentForwarder.evm.bytecode.object}`,
    ).toBe(PAYMENT_FORWARDER_ARTIFACT.bytecode);
  }, 120_000);
});
