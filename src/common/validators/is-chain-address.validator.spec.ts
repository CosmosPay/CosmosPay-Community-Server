import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IsChainAddress } from '@/common/validators/is-chain-address.validator';
import { IsDecimalAmount } from '@/common/validators/is-decimal-amount.validator';

class Body {
  chain?: string;
  @IsChainAddress('chain') address!: string;
  @IsDecimalAmount('chain') amount!: string;
}

const STELLAR = 'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';
const SOLANA = 'So11111111111111111111111111111111111111112';
const MONAD = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

async function errors(body: Record<string, unknown>) {
  const found = await validate(plainToInstance(Body, body));
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
});
