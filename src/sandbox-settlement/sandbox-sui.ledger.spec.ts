import type { PaymentDeposit, SandboxPayout } from '@generated/prisma/client';
import { ApiError } from '@/common/errors/api-error';
import {
  ed25519DepositSecret,
  parseDepositPath,
  treasurySubkey,
} from '@/sandbox-settlement/sandbox-hd';
import { SuiGraphqlError } from '@/sandbox-settlement/sandbox-sui.client';
import {
  packSuiSigned,
  suiAddressOfSecret,
  suiTransactionDigest,
  unpackSuiSigned,
} from '@/sandbox-settlement/sandbox-sui.codec';
import {
  SUI_COIN_TYPE,
  SUI_TESTNET_USDC,
  SUI_TRANSFER_GAS_BUDGET,
} from '@/sandbox-settlement/sandbox-sui.constants';
import { SandboxSuiLedger } from '@/sandbox-settlement/sandbox-sui.ledger';

const SEED = '0x' + '42'.repeat(32);
const TREASURY_KEY = '0x' + '07'.repeat(32);
const TREASURY = suiAddressOfSecret(treasurySubkey(TREASURY_KEY, 'sui'));
const MERCHANT = '0x' + 'ab'.repeat(32);
const DIGEST = '6tA8ZbFcY9ULLRmYjq5yJ9kQ6dJXkUCfNVDuxM9KHzyE';

const coin = (id: string, balance: bigint, version = 3n) => ({
  ref: { objectId: '0x' + id.repeat(64), version, digest: DIGEST },
  balance,
});

function build(client: Partial<Record<string, jest.Mock>> = {}): {
  ledger: SandboxSuiLedger;
  client: Record<string, jest.Mock>;
} {
  const mocks: Record<string, jest.Mock> = {
    balance: jest.fn(),
    coins: jest.fn(),
    referenceGasPrice: jest.fn().mockResolvedValue(1000n),
    transactionStatus: jest.fn().mockResolvedValue(null),
    execute: jest.fn().mockResolvedValue('SUCCESS'),
    ...client,
  };
  const config = {
    get: () => ({ depositSeed: SEED, treasuryPrivateKey: TREASURY_KEY }),
  } as never;
  return {
    ledger: new SandboxSuiLedger(config, mocks as never),
    client: mocks,
  };
}

const balances =
  (byType: Record<string, { coins: bigint; addressBalance?: bigint }>) =>
  (_owner: string, type: string) => {
    const b = byType[type] ?? { coins: 0n };
    const parked = b.addressBalance ?? 0n;
    return Promise.resolve({
      total: b.coins + parked,
      coins: b.coins,
      addressBalance: parked,
    });
  };

const transfer = {
  network: 'sui' as const,
  token: SUI_TESTNET_USDC,
  recipient: MERCHANT,
  amount: 25_000_000n,
};

describe('SandboxSuiLedger', () => {
  it('derives a fresh deposit address per payment from the seed (SLIP-0010, coin 784)', () => {
    const { ledger } = build();
    const a = ledger.newDeposit();
    const b = ledger.newDeposit();
    expect(a.address).not.toBe(b.address);
    expect(a.memo).toBeNull();
    const indexes = parseDepositPath(a.locator, 784);
    expect(indexes).not.toBeNull();
    expect(a.address).toBe(
      suiAddressOfSecret(ed25519DepositSecret(SEED, 784, indexes!)),
    );
    expect(a.address).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('keeps the treasury apart from the EVM key: its own derived address', () => {
    const { ledger } = build();
    expect(ledger.treasuryAddress()).toBe(TREASURY);
  });

  it('counts coin objects and address balance alike as arrived', async () => {
    const { ledger, client } = build({
      balance: jest.fn(
        balances({ [SUI_TESTNET_USDC]: { coins: 5n, addressBalance: 7n } }),
      ),
    });
    await expect(
      ledger.received({
        depositAddress: '0x' + '1'.repeat(64),
        originContract: SUI_TESTNET_USDC,
      } as PaymentDeposit),
    ).resolves.toBe(12n);
    expect(client.balance).toHaveBeenCalledWith(
      '0x' + '1'.repeat(64),
      SUI_TESTNET_USDC,
    );
  });

  it('blocks while the treasury lacks USDC coins or gas, naming what is parked', async () => {
    const short = build({
      balance: jest.fn(
        balances({
          [SUI_TESTNET_USDC]: { coins: 1n, addressBalance: 99_000_000n },
          [SUI_COIN_TYPE]: { coins: 10n ** 9n },
        }),
      ),
    });
    await expect(short.ledger.blocker(transfer)).resolves.toMatch(
      /holds 1 of .* in coin objects \(its 99000000 in the address balance/,
    );
    const noGas = build({
      balance: jest.fn(
        balances({
          [SUI_TESTNET_USDC]: { coins: 10n ** 8n },
          [SUI_COIN_TYPE]: { coins: SUI_TRANSFER_GAS_BUDGET - 1n },
        }),
      ),
    });
    await expect(noGas.ledger.blocker(transfer)).resolves.toMatch(/gas budget/);
    const ready = build({
      balance: jest.fn(
        balances({
          [SUI_TESTNET_USDC]: { coins: 10n ** 8n },
          [SUI_COIN_TYPE]: { coins: 10n ** 9n },
        }),
      ),
    });
    await expect(ready.ledger.blocker(transfer)).resolves.toBeNull();
  });

  it('signs a transfer that spends the largest coins covering it, its digest as the hash', async () => {
    const { ledger, client } = build({
      coins: jest.fn((_owner: string, type: string) =>
        Promise.resolve(
          type === SUI_COIN_TYPE
            ? [coin('c', 10n ** 9n, 41n)]
            : [coin('a', 20_000_000n), coin('b', 10_000_000n), coin('d', 1n)],
        ),
      ),
    });
    const signed = await ledger.sign(transfer);
    expect(client.coins).toHaveBeenCalledWith(TREASURY, SUI_TESTNET_USDC);
    const { txBytes } = unpackSuiSigned(signed.raw);
    const bytes = Uint8Array.from(Buffer.from(txBytes, 'base64'));
    expect(signed.hash).toBe(suiTransactionDigest(bytes));
    expect(signed.nonce).toBe('41');
    const hex = Buffer.from(bytes).toString('hex');
    // Coins a and b (enough together), never d; the merchant as recipient.
    expect(hex).toContain('a'.repeat(64));
    expect(hex).toContain('b'.repeat(64));
    expect(hex).not.toContain('d'.repeat(64));
    expect(hex).toContain('ab'.repeat(32));
  });

  it('refuses to sign when its coins cannot cover the amount', async () => {
    const { ledger } = build({
      coins: jest.fn().mockResolvedValue([coin('a', 1n)]),
    });
    await expect(ledger.sign(transfer)).rejects.toThrow(/cannot cover/);
  });

  it('follows a payout: known effects decide, otherwise the same bytes are executed again', async () => {
    const raw = packSuiSigned(Uint8Array.from([1, 2, 3]), 'c2ln');
    const row = { txHash: 'H', raw } as SandboxPayout;

    const known = build({
      transactionStatus: jest.fn().mockResolvedValue('FAILURE'),
    });
    await expect(known.ledger.follow(row)).resolves.toBe('failed');
    expect(known.client.execute).not.toHaveBeenCalled();

    const unknown = build();
    await expect(unknown.ledger.follow(row)).resolves.toBe('succeeded');
    expect(unknown.client.execute).toHaveBeenCalledWith('AQID', 'c2ln');
  });

  it('fails a payout whose inputs are gone for good, and waits on any other refusal', async () => {
    const row = {
      txHash: 'H',
      raw: packSuiSigned(Uint8Array.from([1]), 'c2ln'),
    } as SandboxPayout;
    const gone = build({
      execute: jest.fn().mockRejectedValue(
        new SuiGraphqlError(
          // What Sui testnet answered for a spent input on 2026-11-17.
          'Invalid argument: Error checking transaction input objects: Transaction needs to be rebuilt because object 0x1 version 0x139f3578 (vTnidn2DTLChGL24qAcyfxdb9kC5Lmbbw2p7y1oneqs) is unavailable for consumption, current version: 0x139f3579',
        ),
      ),
    });
    await expect(gone.ledger.follow(row)).resolves.toBe('failed');
    expect(gone.client.transactionStatus).toHaveBeenCalledTimes(2);

    const busy = build({
      execute: jest
        .fn()
        .mockRejectedValue(new SuiGraphqlError('Too many requests')),
    });
    await expect(busy.ledger.follow(row)).resolves.toBe('pending');
  });

  it('answers a refused broadcast as a 502 with the node reason', async () => {
    const { ledger } = build({
      execute: jest.fn().mockRejectedValue(new SuiGraphqlError('bad sig')),
    });
    const err = await ledger
      .broadcast('sui', packSuiSigned(Uint8Array.from([1]), 'c2ln'))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).getStatus()).toBe(502);
    expect((err as Error).message).toMatch(/bad sig/);
  });

  it('links the testnet explorer', () => {
    expect(build().ledger.explorerTx('sui', 'D')).toBe(
      'https://suiscan.xyz/testnet/tx/D',
    );
  });
});
