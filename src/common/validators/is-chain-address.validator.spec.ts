import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  IsChainAddress,
  IsSwapChainAddress,
} from '@/common/validators/is-chain-address.validator';
import {
  IsDecimalAmount,
  IsSwapDecimalAmount,
} from '@/common/validators/is-decimal-amount.validator';

class Body {
  chain?: string;
  @IsChainAddress('chain') address!: string;
  @IsDecimalAmount('chain') amount!: string;
}

class SwapBody {
  chain?: string;
  @IsSwapChainAddress('chain') address!: string;
  @IsSwapDecimalAmount('chain') amount!: string;
}

const STELLAR = 'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';
const SOLANA = 'So11111111111111111111111111111111111111112';
const MONAD = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

const BITCOIN =
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0';

async function errors(
  body: Record<string, unknown>,
  type: typeof Body | typeof SwapBody = Body,
) {
  const found = await validate(plainToInstance(type, body));
  return found.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('IsChainAddress / IsDecimalAmount', () => {
  it('treats a body with no chain as Stellar, with the message Stellar always got', async () => {
    expect(await errors({ address: STELLAR, amount: '1.1234567' })).toEqual([]);
    expect(await errors({ address: MONAD, amount: '1' })).toEqual([
      'address must be a valid Stellar account address (G...)',
    ]);
    expect(await errors({ address: STELLAR, amount: '1.12345678' })).toEqual([
      'amount must be a positive decimal with up to 7 decimal places',
    ]);
  });

  it('checks the address against the named chain', async () => {
    expect(
      await errors({ chain: 'solana', address: SOLANA, amount: '1' }),
    ).toEqual([]);
    expect(
      await errors({ chain: 'monad', address: MONAD, amount: '1' }),
    ).toEqual([]);
    expect(
      await errors({ chain: 'monad', address: SOLANA, amount: '1' }),
    ).toEqual([
      'address must be a valid Monad (EVM) address (0x + 40 hex) for chain monad',
    ]);
  });

  it('admits up to 18 places where a token may have them', async () => {
    expect(
      await errors({
        chain: 'monad',
        address: MONAD,
        amount: '0.000000000000000001',
      }),
    ).toEqual([]);
    expect(
      await errors({
        chain: 'solana',
        address: SOLANA,
        amount: '0.0000000000000000001',
      }),
    ).toEqual([
      'amount must be a positive decimal with up to 18 decimal places',
    ]);
  });

  it('does not accept a swap-only chain’s address outside cross-chain swaps', async () => {
    // `@IsIn(CHAINS)` on the chain field reports the chain; the address check
    // must not quietly pass an Ethereum or Bitcoin address on its own.
    expect(
      await errors({ chain: 'ethereum', address: MONAD, amount: '1' }),
    ).toEqual(['address must be a valid address for the given chain']);
    expect(
      await errors({ chain: 'bitcoin', address: BITCOIN, amount: '1' }),
    ).toEqual(['address must be a valid address for the given chain']);
  });
});

describe('IsSwapChainAddress / IsSwapDecimalAmount', () => {
  it('accepts the payment chains exactly as IsChainAddress does', async () => {
    expect(
      await errors({ chain: 'monad', address: MONAD, amount: '1' }, SwapBody),
    ).toEqual([]);
    expect(
      await errors({ address: STELLAR, amount: '1.12345678' }, SwapBody),
    ).toEqual([
      'amount must be a positive decimal with up to 7 decimal places',
    ]);
  });

  it.each(['ethereum', 'arbitrum', 'base'])(
    'checks a %s address as EVM, with up to 18 places',
    async (chain) => {
      expect(
        await errors(
          { chain, address: MONAD, amount: '0.000000000000000001' },
          SwapBody,
        ),
      ).toEqual([]);
      expect(
        await errors({ chain, address: SOLANA, amount: '1' }, SwapBody),
      ).toEqual([
        `address must be a valid ${chain[0].toUpperCase()}${chain.slice(1)} (EVM) address (0x + 40 hex) for chain ${chain}`,
      ]);
    },
  );

  it('checks a Bitcoin address by its checksum, with up to 8 places', async () => {
    expect(
      await errors(
        { chain: 'bitcoin', address: BITCOIN, amount: '0.00000001' },
        SwapBody,
      ),
    ).toEqual([]);
    expect(
      await errors(
        { chain: 'bitcoin', address: `${BITCOIN.slice(0, -1)}1`, amount: '1' },
        SwapBody,
      ),
    ).toEqual([
      'address must be a valid Bitcoin mainnet address (bc1q..., bc1p..., 1... or 3...) for chain bitcoin',
    ]);
    expect(
      await errors(
        { chain: 'bitcoin', address: BITCOIN, amount: '0.000000001' },
        SwapBody,
      ),
    ).toEqual([
      'amount must be a positive decimal with up to 8 decimal places',
    ]);
  });
});
