import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IsCrossChainAddress } from '@/cross-chain-swaps/is-cross-chain-address.validator';

class Body {
  chain?: string;
  @IsCrossChainAddress('chain') address!: string;
}

async function errors(body: Record<string, unknown>) {
  const found = await validate(plainToInstance(Body, body));
  return found.flatMap((e) => Object.values(e.constraints ?? {}));
}

describe('IsCrossChainAddress', () => {
  it('checks the address against the network the chain field names', async () => {
    expect(
      await errors({
        chain: 'eth',
        address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      }),
    ).toEqual([]);
    expect(
      await errors({
        chain: 'btc',
        address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      }),
    ).toEqual([]);
    expect(await errors({ chain: 'near', address: 'alice.near' })).toEqual([]);
  });

  it('names the shape it expected and the chain it checked against', async () => {
    expect(
      await errors({
        chain: 'btc',
        address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      }),
    ).toEqual([
      'address must be a valid Bitcoin address (bc1..., 1... or 3...) for chain btc',
    ]);
    // Monad keeps the message it had under IsChainAddress.
    expect(await errors({ chain: 'monad', address: 'alice.near' })).toEqual([
      'address must be a valid Monad (EVM) address (0x + 40 hex) for chain monad',
    ]);
  });

  it('refuses any address when the chain is not a network it reaches', async () => {
    for (const chain of [undefined, 'qtc', 'ethereum']) {
      expect(
        await errors({
          chain,
          address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
        }),
      ).toEqual(['address must be a valid address for the given chain']);
    }
  });
});
