import 'reflect-metadata';
import { Keypair } from '@stellar/stellar-sdk';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { encodeBase58 } from '@/chains/chain-address';
import { CreateCustomerDto } from '@/customers/dto/create-customer.dto';
import { UpdateCustomerDto } from '@/customers/dto/update-customer.dto';

/**
 * A customer's `account` used to be a Stellar key only. It takes an address on any chain the
 * service settles, read from its shape; the service stores it normalized (see the service
 * spec), so this pins only what is admitted and what a refusal says.
 */
const STELLAR = 'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT76';
const SOLANA = 'So11111111111111111111111111111111111111112';
const MONAD = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const REFUSAL =
  'account must be a valid Stellar account address (G...), a valid Solana address ' +
  '(base58, 32 bytes) or a valid Monad (EVM) address (0x + 40 hex)';

async function accountErrors(
  dto: typeof CreateCustomerDto | typeof UpdateCustomerDto,
  body: Record<string, unknown>,
) {
  const found = await validate(plainToInstance(dto, body));
  return found
    .filter((e) => e.property === 'account')
    .flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('CreateCustomerDto.account', () => {
  const key = Keypair.random();

  it.each([
    ['a Stellar account', STELLAR],
    ['a freshly made Stellar account', key.publicKey()],
    ['a Solana address', SOLANA],
    [
      'the same key spelled as a Solana address',
      encodeBase58(key.rawPublicKey()),
    ],
    ['a Monad address, checksummed', MONAD],
    ['a Monad address in lower case', MONAD.toLowerCase()],
  ])('accepts %s', async (_, account) => {
    expect(
      await accountErrors(CreateCustomerDto, { name: 'Ada', account }),
    ).toEqual([]);
  });

  it('stays optional', async () => {
    expect(await accountErrors(CreateCustomerDto, { name: 'Ada' })).toEqual([]);
  });

  it.each([
    [
      'a Stellar key with a broken checksum',
      'GARMB7W3FCR3GKIM3FLWVJASC2PUZ4VHUJZTNJVWWKNTCJNKO6TBCT77',
    ],
    ['a Stellar secret seed', key.secret()],
    ['base58 that is not 32 bytes', '1111'],
    ['an EVM address one hex short', MONAD.slice(0, -1)],
    ['a Bitcoin address', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
    ['an empty string', ''],
    // Longer than any address: refused before any decoding (base58 is quadratic to decode).
    ['a 100 000-character string', '1'.repeat(100_000)],
    ['a number', 42],
  ])('refuses %s, naming the three accepted shapes', async (_, account) => {
    expect(
      await accountErrors(CreateCustomerDto, { name: 'Ada', account }),
    ).toEqual([REFUSAL]);
  });

  it('applies the same rule to an update', async () => {
    expect(await accountErrors(UpdateCustomerDto, { account: SOLANA })).toEqual(
      [],
    );
    expect(await accountErrors(UpdateCustomerDto, { note: 'vip' })).toEqual([]);
    expect(await accountErrors(UpdateCustomerDto, { account: 'G123' })).toEqual(
      [REFUSAL],
    );
  });
});
