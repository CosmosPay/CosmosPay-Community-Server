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

/**
 * `wallets` names each wallet's chain, and the address must be that chain's: a customer holds
 * any number of them, up to the cap, each with an optional label.
 */
describe('CreateCustomerDto.wallets', () => {
  async function walletErrors(body: Record<string, unknown>) {
    const found = await validate(
      plainToInstance(CreateCustomerDto, { name: 'Ada', ...body }),
    );
    const flat = (errs: typeof found): string[] =>
      errs.flatMap((e) => [
        ...Object.values(e.constraints ?? {}),
        ...flat(e.children ?? []),
      ]);
    return flat(found.filter((e) => e.property === 'wallets'));
  }

  it('accepts wallets on every chain, with or without a label', async () => {
    expect(
      await walletErrors({
        wallets: [
          { chain: 'stellar', address: STELLAR, label: 'Freighter' },
          { chain: 'solana', address: SOLANA },
          { chain: 'monad', address: MONAD.toLowerCase() },
        ],
      }),
    ).toEqual([]);
  });

  it('refuses an address of another chain than the one named', async () => {
    expect(
      await walletErrors({ wallets: [{ chain: 'solana', address: STELLAR }] }),
    ).toEqual([
      'address must be a valid Solana address (base58, 32 bytes) for chain solana',
    ]);
  });

  it('refuses a chain payments do not settle on', async () => {
    const errors = await walletErrors({
      wallets: [{ chain: 'eth', address: MONAD }],
    });
    expect(errors).toContain(
      'chain must be one of the following values: stellar, solana, monad',
    );
  });

  it('refuses more than 20 wallets and a label longer than 60 characters', async () => {
    const many = Array.from({ length: 21 }, () => ({
      chain: 'stellar',
      address: STELLAR,
    }));
    expect(await walletErrors({ wallets: many })).toContain(
      'wallets must contain no more than 20 elements',
    );
    expect(
      await walletErrors({
        wallets: [
          { chain: 'stellar', address: STELLAR, label: 'x'.repeat(61) },
        ],
      }),
    ).toEqual(['label must be shorter than or equal to 60 characters']);
  });

  it('is not part of an update: wallets have their own routes', async () => {
    const found = await validate(
      plainToInstance(UpdateCustomerDto, {
        wallets: [{ chain: 'stellar', address: STELLAR }],
      }),
      { whitelist: true, forbidNonWhitelisted: true },
    );
    expect(found.map((e) => e.property)).toEqual(['wallets']);
  });
});
