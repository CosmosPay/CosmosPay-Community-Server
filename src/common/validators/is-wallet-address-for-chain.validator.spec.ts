import { validate } from 'class-validator';
import {
  IsWalletAddressForChain,
  WALLET_ADDRESS_RULES,
  type WalletAddressChain,
} from '@/common/validators/is-wallet-address-for-chain.validator';

class SampleDto {
  chain!: unknown;

  @IsWalletAddressForChain()
  address!: unknown;
}

class CustomChainPropertyDto {
  network!: unknown;

  @IsWalletAddressForChain('network')
  wallet!: unknown;
}

async function errorsFor(chain: unknown, address: unknown): Promise<string[]> {
  const dto = Object.assign(new SampleDto(), { chain, address });
  const errors = await validate(dto);
  return errors.flatMap((e) => Object.values(e.constraints ?? {}));
}

/**
 * One fixture per entry in the table. Typed by the table's keys, so a chain
 * added there without a fixture here fails to compile, not just review.
 */
const FIXTURES: Record<
  WalletAddressChain,
  { valid: string[]; invalid: string[]; message: string }
> = {
  stellar: {
    valid: ['GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76'],
    invalid: [
      // Last character changed, so the StrKey checksum no longer matches.
      'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT77',
      'garmb7w3fcr3gkim3flwvjasc2puz4vhujztnjvwwkntcjnko6tbct76',
      '',
    ],
    message:
      'address must be a valid Stellar account address (G...) for chain stellar',
  },
  solana: {
    valid: [
      // The system program: 32 zero bytes, all leading '1's.
      '11111111111111111111111111111111',
      'So11111111111111111111111111111111111111112',
    ],
    invalid: [
      // 31 zero bytes.
      '1111111111111111111111111111111',
      // '0', 'O', 'I' and 'l' are not in the base58 alphabet.
      'So1111111111111111111111111111111111111111O',
      '',
    ],
    message:
      'address must be a valid Solana address (base58, 32 bytes) for chain solana',
  },
  evm: {
    valid: [
      '0x52908400098527886E0F7030069857D2E4169EE7',
      `0x${'a'.repeat(40)}`,
    ],
    invalid: [
      '52908400098527886E0F7030069857D2E4169EE7',
      '0x52908400098527886E0F7030069857D2E4169EE',
      `0x${'g'.repeat(40)}`,
    ],
    message: 'address must be a valid EVM address (0x + 40 hex) for chain evm',
  },
};

const CHAINS = Object.keys(WALLET_ADDRESS_RULES) as WalletAddressChain[];

describe('IsWalletAddressForChain', () => {
  it('has a fixture for every chain in the table', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...CHAINS].sort());
  });

  describe.each(CHAINS)('chain %s', (chain) => {
    const { valid, invalid, message } = FIXTURES[chain];

    it.each(valid)('accepts %s', async (address) => {
      await expect(errorsFor(chain, address)).resolves.toEqual([]);
    });

    it.each(invalid)(
      'rejects %p with the chain-specific message',
      async (address) => {
        await expect(errorsFor(chain, address)).resolves.toEqual([message]);
      },
    );

    it('rejects a valid address of every other chain', async () => {
      for (const other of CHAINS.filter((c) => c !== chain)) {
        for (const address of FIXTURES[other].valid) {
          await expect(errorsFor(chain, address)).resolves.toEqual([message]);
        }
      }
    });

    it('rejects a non-string address', async () => {
      await expect(errorsFor(chain, 42)).resolves.toEqual([message]);
    });
  });

  it.each([['bitcoin'], [undefined], ['toString'], ['__proto__']])(
    'rejects any address for chain %p, which the table does not name',
    async (chain) => {
      await expect(
        errorsFor(chain, FIXTURES.stellar.valid[0]),
      ).resolves.toEqual([
        'address must be a valid wallet address for the given chain',
      ]);
    },
  );

  it('reads the chain from the property it was given', async () => {
    const dto = Object.assign(new CustomChainPropertyDto(), {
      network: 'evm',
      wallet: FIXTURES.stellar.valid[0],
    });
    const errors = await validate(dto);
    expect(errors.flatMap((e) => Object.values(e.constraints ?? {}))).toEqual([
      'wallet must be a valid EVM address (0x + 40 hex) for chain evm',
    ]);

    dto.wallet = FIXTURES.evm.valid[0];
    await expect(validate(dto)).resolves.toEqual([]);
  });
});
