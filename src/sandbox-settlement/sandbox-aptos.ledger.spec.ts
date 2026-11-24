import type { SandboxPayout } from '@generated/prisma/client';
import {
  aptosAddressOfSecret,
  decodeAptosSignedTransaction,
} from '@/sandbox-settlement/sandbox-aptos.codec';
import { SANDBOX_APTOS_TESTNET } from '@/sandbox-settlement/sandbox-aptos.constants';
import { SandboxAptosLedger } from '@/sandbox-settlement/sandbox-aptos.ledger';
import {
  ed25519DepositSecret,
  parseDepositPath,
  treasurySubkey,
} from '@/sandbox-settlement/sandbox-hd';

const SEED = '0x' + '42'.repeat(32);
const TREASURY_KEY = '0x' + '07'.repeat(32);
const TREASURY = aptosAddressOfSecret(treasurySubkey(TREASURY_KEY, 'aptos'));
const USDC = SANDBOX_APTOS_TESTNET.stablecoin.contract!;
const MERCHANT = '0x' + 'cd'.repeat(32);

function build(overrides: Record<string, jest.Mock> = {}) {
  const client = {
    network: () => SANDBOX_APTOS_TESTNET,
    gasUnitPrice: jest.fn().mockResolvedValue(100n),
    aptBalance: jest.fn().mockResolvedValue(10n ** 8n),
    faBalance: jest.fn().mockResolvedValue(10n ** 9n),
    sequenceNumber: jest.fn().mockResolvedValue(5n),
    submit: jest.fn().mockResolvedValue(undefined),
    transactionByHash: jest.fn().mockResolvedValue(null),
    accountTransactionAt: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
  const config = {
    get: () => ({ depositSeed: SEED, treasuryPrivateKey: TREASURY_KEY }),
  } as never;
  return { ledger: new SandboxAptosLedger(config, client as never), client };
}

const transfer = {
  network: 'aptos' as const,
  token: USDC,
  recipient: MERCHANT,
  amount: 25_000_000n,
};

function row(raw: string, hash: string): SandboxPayout {
  return {
    id: 'pay_1',
    depositId: 'dep_1',
    kind: 'payout',
    network: 'aptos',
    token: USDC,
    recipient: MERCHANT,
    amount: '25000000',
    nonce: '5',
    txHash: hash,
    raw,
    status: 'SENT',
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('SandboxAptosLedger', () => {
  afterEach(() => jest.useRealTimers());

  it('opens each deposit at its own account under coin type 637', () => {
    const { ledger } = build();
    const target = ledger.newDeposit();
    const indexes = parseDepositPath(target.locator, 637);
    expect(indexes).not.toBeNull();
    expect(target.address).toBe(
      aptosAddressOfSecret(ed25519DepositSecret(SEED, 637, indexes!)),
    );
    expect(target.memo).toBeNull();
    expect(ledger.newDeposit().address).not.toBe(target.address);
  });

  it('pays from a treasury key of its own, derived from the configured one', () => {
    expect(build().ledger.treasuryAddress('aptos')).toBe(TREASURY);
  });

  it('reads what arrived as the deposit account primary store balance', async () => {
    const { ledger, client } = build();
    await ledger.received({
      originChain: 'aptos',
      originContract: USDC,
      depositAddress: '0x' + 'ab'.repeat(32),
    } as never);
    expect(client.faBalance).toHaveBeenCalledWith(
      'aptos',
      '0x' + 'ab'.repeat(32),
      USDC,
    );
  });

  it('waits while the treasury lacks gas or the stablecoin', async () => {
    const poor = build({ aptBalance: jest.fn().mockResolvedValue(1n) });
    await expect(poor.ledger.blocker(transfer)).resolves.toMatch(/APT/);
    const short = build({ faBalance: jest.fn().mockResolvedValue(1n) });
    await expect(short.ledger.blocker(transfer)).resolves.toMatch(/below/);
    await expect(build().ledger.blocker(transfer)).resolves.toBeNull();
  });

  it('signs a transfer on chain 2 from the treasury, never reusing a sequence number it signed', async () => {
    const { ledger } = build();
    const first = await ledger.sign(transfer);
    const second = await ledger.sign(transfer);
    const a = decodeAptosSignedTransaction(first.raw);
    expect(a).toMatchObject({
      sender: TREASURY,
      sequenceNumber: 5n,
      chainId: 2,
    });
    expect(a.hash).toBe(first.hash);
    expect(first.nonce).toBe('5');
    // The chain still says 5 (the first is in the mempool): the second takes 6.
    expect(decodeAptosSignedTransaction(second.raw).sequenceNumber).toBe(6n);
    expect(a.expirationSecs).toBeGreaterThan(
      BigInt(Math.floor(Date.now() / 1000)),
    );
  });

  it('follows a committed transfer by its outcome, a pending one as pending', async () => {
    const { ledger } = build();
    const signed = await ledger.sign(transfer);
    const ok = build({
      transactionByHash: jest.fn().mockResolvedValue({
        state: 'committed',
        success: true,
        vmStatus: 'Executed successfully',
        hash: signed.hash,
      }),
    });
    await expect(ok.ledger.follow(row(signed.raw, signed.hash))).resolves.toBe(
      'succeeded',
    );
    const aborted = build({
      transactionByHash: jest.fn().mockResolvedValue({
        state: 'committed',
        success: false,
        vmStatus: 'Move abort',
        hash: signed.hash,
      }),
    });
    await expect(
      aborted.ledger.follow(row(signed.raw, signed.hash)),
    ).resolves.toBe('failed');
    const pending = build({
      transactionByHash: jest.fn().mockResolvedValue({ state: 'pending' }),
    });
    await expect(
      pending.ledger.follow(row(signed.raw, signed.hash)),
    ).resolves.toBe('pending');
    expect(pending.client.submit).not.toHaveBeenCalled();
  });

  it('submits the same bytes again while an unknown transfer has not expired', async () => {
    const { ledger, client } = build();
    const signed = await ledger.sign(transfer);
    await expect(ledger.follow(row(signed.raw, signed.hash))).resolves.toBe(
      'pending',
    );
    expect(client.submit).toHaveBeenCalledWith('aptos', signed.raw);
  });

  it('calls an expired unknown transfer failed only when it provably never ran', async () => {
    const signed = await build().ledger.sign(transfer);
    jest.useFakeTimers({ now: Date.now() + 2 * 3600 * 1000 });

    // Its sequence number was never consumed: it can never run now.
    const unused = build({ sequenceNumber: jest.fn().mockResolvedValue(5n) });
    await expect(
      unused.ledger.follow(row(signed.raw, signed.hash)),
    ).resolves.toBe('failed');
    expect(unused.client.submit).not.toHaveBeenCalled();

    // Consumed by another transaction.
    const other = build({
      sequenceNumber: jest.fn().mockResolvedValue(6n),
      accountTransactionAt: jest.fn().mockResolvedValue({
        state: 'committed',
        success: true,
        vmStatus: '',
        hash: '0x' + 'ee'.repeat(32),
      }),
    });
    await expect(
      other.ledger.follow(row(signed.raw, signed.hash)),
    ).resolves.toBe('failed');

    // Consumed by something this node no longer lists: never guessed failed.
    const pruned = build({ sequenceNumber: jest.fn().mockResolvedValue(6n) });
    await expect(
      pruned.ledger.follow(row(signed.raw, signed.hash)),
    ).resolves.toBe('pending');
  });

  it('links the explorer on the test network', () => {
    expect(build().ledger.explorerTx('aptos', '0xab')).toBe(
      'https://explorer.aptoslabs.com/txn/0xab?network=testnet',
    );
  });
});
