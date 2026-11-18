import type { PaymentIntent } from '@generated/prisma/client';
import { toChecksumAddress } from '@/chains/chain-address';
import { addressTopic } from '@/evm/eip681';
import {
  ARC_TRANSFER_EMITTER,
  ARC_USDC,
  ERC20_TRANSFER_SELECTOR,
  ERC20_TRANSFER_TOPIC,
  EVM_NATIVE_TOKEN_INTERFACES,
} from '@/evm/evm.constants';
import type { EvmLog, EvmReceipt, EvmTransaction } from '@/evm/evm-rpc.client';
import {
  EvmVerifierService,
  gasCoinOf,
  loggedAmount,
} from '@/payment-intents/evm-verifier.service';

/**
 * Arc's USDC is its gas coin: a payer's wallet may send it as the ERC-20
 * (`0x3600…`, 6 decimals) or as a plain value transfer (18 decimals). Both
 * are logged by the system emitter (EIP-7708, 18 decimals); the ERC-20 one is
 * ALSO logged by the token. The figures below are a real Arc Testnet receipt
 * (0xf40cf70d…, 2026-11-18): one transfer, 9409212000000000000 at the emitter
 * and 9409212 at the token.
 */
const DEST = toChecksumAddress('0x49f9636fe15883e16d5e356a4ea08c9fe6bc219b');
const PAYER = toChecksumAddress('0xbd9a3d774380f7dbdb24157cd942583afbe0baea');
const HASH = `0x${'f4'.repeat(32)}`;
const CREATED = new Date('2026-11-18T12:00:00Z');
const AFTER = CREATED.getTime() / 1000 + 5;
const MICRO = 10n ** 12n;

const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'pi_arc',
    chain: 'arc',
    network: 'testnet',
    kind: 'PAY',
    destination: DEST,
    amount: '9.409212',
    asset: 'USDC',
    assetIssuer: ARC_USDC,
    assetDecimals: 6,
    chainReference: null,
    chainCursor: '100',
    createdAt: CREATED,
    ...over,
  } as PaymentIntent;
}

function log(emitter: string, value: bigint, to = DEST): EvmLog {
  return {
    address: emitter.toLowerCase(),
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(to)],
    data: word(value),
    blockNumber: '0x65',
    transactionHash: HASH,
    logIndex: '0x0',
  };
}

/** What an ERC-20 `transfer` on the interface logs: both emitters, one movement. */
const erc20Logs = (micro: bigint, to = DEST) => [
  log(ARC_TRANSFER_EMITTER, micro * MICRO, to),
  log(ARC_USDC, micro, to),
];

function tx(over: Partial<EvmTransaction> = {}): EvmTransaction {
  return {
    hash: HASH,
    from: PAYER.toLowerCase(),
    to: ARC_USDC,
    value: '0x0',
    input: '0x',
    blockNumber: '0x65',
    ...over,
  };
}

function receipt(logs: EvmLog[], status = '0x1'): EvmReceipt {
  return {
    transactionHash: HASH,
    from: PAYER,
    to: ARC_USDC,
    status,
    blockNumber: '0x65',
    logs,
  };
}

function make(opts: {
  tx?: EvmTransaction;
  receipt?: EvmReceipt;
  head?: bigint;
  logs?: EvmLog[][];
}) {
  const getLogs = jest.fn();
  for (const page of opts.logs ?? []) getLogs.mockResolvedValueOnce(page);
  getLogs.mockResolvedValue([]);
  const rpc = {
    getTransaction: jest.fn().mockResolvedValue(opts.tx ?? tx()),
    getReceipt: jest
      .fn()
      .mockResolvedValue(opts.receipt ?? receipt(erc20Logs(9_409_212n))),
    blockTimestamp: jest.fn().mockResolvedValue(AFTER),
    blockNumber: jest.fn().mockResolvedValue(opts.head ?? 100n),
    logBlockRange: jest.fn().mockReturnValue(5_000),
    getLogs,
  };
  return { verifier: new EvmVerifierService(rpc as never), rpc };
}

describe('Arc USDC: 6 versus 18 decimals', () => {
  const gasCoin = EVM_NATIVE_TOKEN_INTERFACES.arc!;

  it('is the ERC-20 interface over the native coin, logged by the system emitter', () => {
    expect(gasCoin).toEqual({
      token: ARC_USDC,
      decimals: 6,
      transferEmitter: '0xfffffffffffffffffffffffffffffffffffffffe',
    });
    expect(gasCoinOf('arc', ARC_USDC.toUpperCase().replace('0X', '0x'))).toBe(
      gasCoin,
    );
    expect(gasCoinOf('monad', ARC_USDC)).toBeNull();
    expect(EVM_NATIVE_TOKEN_INTERFACES.monad).toBeNull();
  });

  it('cuts an emitter amount from 18 decimals to 6, dropping the dust as balanceOf does', () => {
    expect(loggedAmount('arc', gasCoin, word(9_409_212n * MICRO))).toBe(
      9_409_212n,
    );
    expect(loggedAmount('arc', gasCoin, word(MICRO - 1n))).toBe(0n);
    expect(loggedAmount('arc', gasCoin, word(10n ** 18n + 500_000n))).toBe(
      1_000_000n,
    );
    // Any other token keeps its own units.
    expect(loggedAmount('arc', null, word(9_409_212n))).toBe(9_409_212n);
    expect(loggedAmount('arc', gasCoin, 'nope')).toBeNull();
  });
});

describe('EvmVerifierService on Arc: verifyByHash', () => {
  it('reads the transaction on Arc, never on Monad', async () => {
    const { verifier, rpc } = make({});
    await verifier.verifyByHash(intent(), HASH);
    expect(rpc.getTransaction).toHaveBeenCalledWith('arc', 'testnet', HASH);
    expect(rpc.getReceipt).toHaveBeenCalledWith('arc', 'testnet', HASH);
  });

  it('settles an ERC-20 transfer, logged by both emitters, for exactly the amount', async () => {
    const { verifier } = make({});
    await expect(verifier.verifyByHash(intent(), HASH)).resolves.toEqual({
      valid: true,
      txHash: HASH,
      payer: PAYER,
      paidAt: expect.any(Date),
    });
  });

  it('settles the same payment sent as a native value transfer (the emitter log alone)', async () => {
    const { verifier } = make({
      tx: tx({ to: DEST.toLowerCase(), value: word(9_409_212n * MICRO) }),
      receipt: receipt([log(ARC_TRANSFER_EMITTER, 9_409_212n * MICRO)]),
    });
    expect((await verifier.verifyByHash(intent(), HASH)).valid).toBe(true);
  });

  it('counts a native payment with sub-micro dust for its 6-decimal amount', async () => {
    const dusty = 9_409_212n * MICRO + 999_999_999_999n;
    const { verifier } = make({
      receipt: receipt([log(ARC_TRANSFER_EMITTER, dusty)]),
    });
    expect((await verifier.verifyByHash(intent(), HASH)).valid).toBe(true);
    const short = 9_409_212n * MICRO - 1n;
    const { verifier: other } = make({
      receipt: receipt([log(ARC_TRANSFER_EMITTER, short)]),
    });
    expect((await other.verifyByHash(intent(), HASH)).valid).toBe(false);
  });

  it('never reads the token’s own log: only the emitter counts, so nothing counts twice', async () => {
    // A token log with no emitter log (which Arc never writes) settles nothing.
    const { verifier } = make({
      receipt: receipt([log(ARC_USDC, 9_409_212n)]),
    });
    expect((await verifier.verifyByHash(intent(), HASH)).valid).toBe(false);
  });

  it('never adds the two logs of one transfer together', async () => {
    // 1 USDC moved, logged twice: it does not pay a 2 USDC intent.
    const { verifier } = make({ receipt: receipt(erc20Logs(1_000_000n)) });
    expect(
      (await verifier.verifyByHash(intent({ amount: '2' }), HASH)).valid,
    ).toBe(false);
    const { verifier: exact } = make({
      receipt: receipt(erc20Logs(1_000_000n)),
    });
    expect(
      (await exact.verifyByHash(intent({ amount: '1' }), HASH)).valid,
    ).toBe(true);
  });

  it('refuses a transfer to another payee', async () => {
    const { verifier } = make({
      receipt: receipt(erc20Logs(9_409_212n, PAYER)),
    });
    expect((await verifier.verifyByHash(intent(), HASH)).valid).toBe(false);
  });

  it('answers a reverted attempt, either way of paying, as a plain mismatch, never failedOnChain', async () => {
    // Nothing in a reverted EVM transaction is this intent's: anyone could
    // revert one for the price of gas and make the intent FAILED.
    const input =
      ERC20_TRANSFER_SELECTOR +
      addressTopic(DEST).slice(2) +
      word(9_409_212n).slice(2);
    for (const reverted of [
      tx({ input }),
      tx({ to: DEST.toLowerCase(), value: word(9_409_212n * MICRO) }),
    ]) {
      const { verifier } = make({
        tx: reverted,
        receipt: receipt([], '0x0'),
      });
      const result = await verifier.verifyByHash(intent(), HASH);
      expect(result).toEqual({
        valid: false,
        reason: 'Transaction failed on-chain',
      });
      expect(result.failedOnChain).toBeUndefined();
    }
  });

  it('with a deposit address: the emitter log to it, at or above the amount', async () => {
    const DEPOSIT = '0xC830d264C14ebDB31cdEa0Fb6f83C5b0D8EEc52F';
    const deposit = intent({ chainReference: DEPOSIT, amount: '1' });
    for (const micro of [1_000_000n, 1_500_000n]) {
      const { verifier } = make({
        receipt: receipt([log(ARC_TRANSFER_EMITTER, micro * MICRO, DEPOSIT)]),
      });
      expect((await verifier.verifyByHash(deposit, HASH)).valid).toBe(true);
    }
    const { verifier } = make({
      receipt: receipt([log(ARC_TRANSFER_EMITTER, 999_999n * MICRO, DEPOSIT)]),
    });
    expect((await verifier.verifyByHash(deposit, HASH)).valid).toBe(false);
  });

  it('reads EURC, like any other ERC-20, from its own Transfer log', async () => {
    const EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
    const { verifier } = make({
      tx: tx({ to: EURC.toLowerCase() }),
      receipt: receipt([log(EURC, 2_500_000n)]),
    });
    const eurc = intent({ asset: 'EURC', assetIssuer: EURC, amount: '2.5' });
    expect((await verifier.verifyByHash(eurc, HASH)).valid).toBe(true);
  });
});

describe('EvmVerifierService on Arc: findMatchingPayment', () => {
  it('scans the system emitter’s Transfer logs to the destination, on Arc', async () => {
    const { verifier, rpc } = make({
      head: 12_000n,
      logs: [[], [log(ARC_TRANSFER_EMITTER, 9_409_212n * MICRO)]],
    });
    const result = await verifier.findMatchingPayment(intent());
    expect(result).toMatchObject({ valid: true, txHash: HASH, payer: PAYER });
    expect(rpc.blockNumber).toHaveBeenCalledWith('arc', 'testnet');
    expect(rpc.logBlockRange).toHaveBeenCalledWith('arc');
    expect(rpc.getLogs).toHaveBeenNthCalledWith(1, 'arc', 'testnet', {
      address: '0xfffffffffffffffffffffffffffffffffffffffe',
      topics: [ERC20_TRANSFER_TOPIC, null, addressTopic(DEST)],
      fromBlock: 101n,
      toBlock: 5_100n,
    });
  });

  it('skips a log of another amount and resumes from where it stopped', async () => {
    const { verifier } = make({
      head: 200n,
      logs: [[log(ARC_TRANSFER_EMITTER, 9_409_211n * MICRO)]],
    });
    await expect(verifier.findMatchingPayment(intent())).resolves.toEqual({
      valid: false,
      reason: 'No matching payment found yet',
      nextCursor: '200',
    });
  });
});
