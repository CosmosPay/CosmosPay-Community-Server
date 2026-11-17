import { ed25519 } from '@noble/curves/ed25519.js';
import type { PaymentDeposit, SandboxPayout } from '@generated/prisma/client';
import {
  ed25519DepositSecret,
  parseDepositPath,
  treasurySubkey,
} from '@/sandbox-settlement/sandbox-hd';
import {
  nearAccountOfSecret,
  signNearTransaction,
} from '@/sandbox-settlement/sandbox-near.codec';
import { SandboxNearLedger } from '@/sandbox-settlement/sandbox-near.ledger';

const SEED = '0x' + '42'.repeat(32);
const TREASURY_KEY = '0x' + '07'.repeat(32);
const TREASURY_SECRET = treasurySubkey(TREASURY_KEY, 'near');
const TREASURY = nearAccountOfSecret(TREASURY_SECRET);
const USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const BLOCK = new Uint8Array(32).fill(3);
const NEAR = 10n ** 24n;

function client(overrides: Record<string, unknown> = {}) {
  return {
    account: jest.fn().mockResolvedValue({
      amount: 5n * NEAR,
      locked: 0n,
      storageUsage: 182n,
    }),
    ftBalanceOf: jest.fn().mockResolvedValue(100_000_000n),
    storageBalanceOf: jest.fn().mockResolvedValue(null),
    accessKeyNonce: jest.fn().mockResolvedValue(41n),
    finalBlockHash: jest.fn().mockResolvedValue(BLOCK),
    sendTransaction: jest.fn().mockResolvedValue('accepted'),
    transaction: jest.fn().mockResolvedValue({ state: 'unknown' }),
    ...overrides,
  };
}

function build(near = client()) {
  const settings = {
    sandbox: {
      depositSeed: SEED,
      treasuryPrivateKey: TREASURY_KEY,
      rpcUrls: {},
      cusdAddresses: {},
      timeoutMs: 1000,
    },
  };
  const config = {
    get: (key: keyof typeof settings) => settings[key],
  } as never;
  return { ledger: new SandboxNearLedger(config, near as never), near };
}

const deposit = (overrides: Partial<PaymentDeposit> = {}) =>
  ({
    id: 'dep_1',
    originChain: 'near',
    originContract: USDC,
    depositAddress: 'd'.repeat(64),
    ...overrides,
  }) as PaymentDeposit;

describe('SandboxNearLedger', () => {
  it('opens one implicit account per payment under coin type 397, never the treasury', () => {
    const { ledger } = build();
    const target = ledger.newDeposit();
    const indexes = parseDepositPath(target.locator, 397);
    expect(indexes).not.toBeNull();
    expect(target.address).toBe(
      nearAccountOfSecret(ed25519DepositSecret(SEED, 397, indexes!)),
    );
    expect(target.memo).toBeNull();
    expect(ledger.newDeposit().address).not.toBe(target.address);
    expect(ledger.treasuryAddress()).toBe(TREASURY);
    expect(TREASURY).not.toBe(target.address);
  });

  it('reads what arrived as the deposit account token balance', async () => {
    const { ledger, near } = build();
    near.ftBalanceOf.mockResolvedValueOnce(25_000_000n);
    await expect(ledger.received(deposit())).resolves.toBe(25_000_000n);
    expect(near.ftBalanceOf).toHaveBeenCalledWith(USDC, 'd'.repeat(64));
  });

  it('signs one transaction to the token: register the recipient, then transfer', async () => {
    const { ledger, near } = build();
    const transfer = {
      network: 'near' as const,
      token: USDC,
      recipient: 'merchant.testnet',
      amount: 25_000_000n,
    };
    const signed = await ledger.sign(transfer);
    expect(signed.nonce).toBe('42');
    const expected = signNearTransaction(
      {
        signerId: TREASURY,
        publicKey: ed25519.getPublicKey(TREASURY_SECRET),
        nonce: 42n,
        receiverId: USDC,
        blockHash: BLOCK,
        actions: [
          {
            methodName: 'storage_deposit',
            args: { account_id: 'merchant.testnet', registration_only: true },
            gas: 10_000_000_000_000n,
            deposit: 1_250_000_000_000_000_000_000n,
          },
          {
            methodName: 'ft_transfer',
            args: { receiver_id: 'merchant.testnet', amount: '25000000' },
            gas: 15_000_000_000_000n,
            deposit: 1n,
          },
        ],
      },
      TREASURY_SECRET,
    );
    expect(signed).toEqual({ ...expected, nonce: '42' });
    expect(near.sendTransaction).not.toHaveBeenCalled();

    // A second send before the node saw the first never reuses its nonce.
    await expect(ledger.sign(transfer)).resolves.toMatchObject({
      nonce: '43',
    });
  });

  it('blocks while the treasury has no account, too little NEAR, or too little USDC', async () => {
    const transfer = {
      network: 'near' as const,
      token: USDC,
      recipient: 'merchant.testnet',
      amount: 25_000_000n,
    };
    const missing = build(
      client({ account: jest.fn().mockResolvedValue(null) }),
    );
    await expect(missing.ledger.blocker(transfer)).resolves.toMatch(
      /does not exist.*send it test NEAR/,
    );
    const poor = build(
      client({
        account: jest.fn().mockResolvedValue({
          amount: NEAR / 1000n,
          locked: 0n,
          storageUsage: 182n,
        }),
      }),
    );
    await expect(poor.ledger.blocker(transfer)).resolves.toMatch(
      /can spend .* yoctoNEAR/,
    );
    const dry = build(client({ ftBalanceOf: jest.fn().mockResolvedValue(1n) }));
    await expect(dry.ledger.blocker(transfer)).resolves.toMatch(
      /holds 1 of .*fund it/,
    );
    await expect(build().ledger.blocker(transfer)).resolves.toBeNull();
  });

  it('registers a waiting deposit account with the token once, and never throws doing it', async () => {
    const { ledger, near } = build();
    await ledger.prepareDeposit(deposit());
    expect(near.sendTransaction).toHaveBeenCalledTimes(1);

    const registered = build(
      client({ storageBalanceOf: jest.fn().mockResolvedValue(125n) }),
    );
    await registered.ledger.prepareDeposit(deposit());
    expect(registered.near.sendTransaction).not.toHaveBeenCalled();

    const down = build(
      client({
        storageBalanceOf: jest.fn().mockRejectedValue(new Error('node down')),
      }),
    );
    await expect(
      down.ledger.prepareDeposit(deposit()),
    ).resolves.toBeUndefined();
  });

  it('follows a payout: final outcome as is, unknown rebroadcast with the same bytes, expired as failed', async () => {
    const row = { txHash: 'H', raw: 'RAW', kind: 'payout' } as SandboxPayout;
    const done = build(
      client({
        transaction: jest.fn().mockResolvedValue({ state: 'succeeded' }),
      }),
    );
    await expect(done.ledger.follow(row)).resolves.toBe('succeeded');
    expect(done.near.transaction).toHaveBeenCalledWith('H', TREASURY);
    expect(done.near.sendTransaction).not.toHaveBeenCalled();

    const reverted = build(
      client({
        transaction: jest
          .fn()
          .mockResolvedValue({ state: 'failed', reason: 'panic' }),
      }),
    );
    await expect(reverted.ledger.follow(row)).resolves.toBe('failed');

    const lost = build();
    await expect(lost.ledger.follow(row)).resolves.toBe('pending');
    expect(lost.near.sendTransaction).toHaveBeenCalledWith('RAW');

    const expired = build(
      client({ sendTransaction: jest.fn().mockResolvedValue('expired') }),
    );
    await expect(expired.ledger.follow(row)).resolves.toBe('failed');
  });

  it('registers the treasury itself once it holds NEAR', async () => {
    const { ledger, near } = build();
    const lines = await ledger.prepareTreasury();
    expect(lines[0]).toMatch(/registered with the test USDC \(tx=/);
    expect(near.sendTransaction).toHaveBeenCalledTimes(1);
    const done = build(
      client({ storageBalanceOf: jest.fn().mockResolvedValue(125n) }),
    );
    await expect(done.ledger.prepareTreasury()).resolves.toEqual([
      `treasury ${TREASURY} is registered with the test USDC`,
    ]);
  });
});
