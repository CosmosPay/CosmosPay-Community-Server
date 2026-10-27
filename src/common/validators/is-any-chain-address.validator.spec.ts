import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IsAnyChainAddress } from '@/common/validators/is-any-chain-address.validator';

class Body {
  @IsAnyChainAddress() account!: unknown;
}

const STELLAR = 'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';
const SOLANA = 'So11111111111111111111111111111111111111112';
const MONAD = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

async function errors(account: unknown) {
  const found = await validate(plainToInstance(Body, { account }));
  return found.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('IsAnyChainAddress', () => {
  it.each([STELLAR, SOLANA, MONAD, MONAD.toLowerCase()])(
    'accepts %s with no chain named',
    async (account) => {
      expect(await errors(account)).toEqual([]);
    },
  );

  it.each([
    'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT77',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe',
    'not an address',
    42,
  ])('refuses %s, naming the three shapes it takes', async (account) => {
    expect(await errors(account)).toEqual([
      'account must be a valid Stellar account address (G...), a valid Solana ' +
        'address (base58, 32 bytes) or a valid Monad (EVM) address (0x + 40 hex)',
    ]);
  });
});
