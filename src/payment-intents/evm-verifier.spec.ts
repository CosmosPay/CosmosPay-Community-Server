import type { PaymentIntent } from '@generated/prisma/client';
import { addressTopic } from '@/evm/eip681';
import {
  ERC20_TRANSFER_SELECTOR,
  ERC20_TRANSFER_TOPIC,
} from '@/evm/evm.constants';
import type { EvmReceipt, EvmTransaction } from '@/evm/evm-rpc.client';
import { EvmVerifierService } from '@/payment-intents/evm-verifier.service';

const DEST = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const PAYER = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const TOKEN = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const HASH = `0x${'ab'.repeat(32)}`;
const CREATED = new Date('2026-09-29T12:00:00Z');
const AFTER = CREATED.getTime() / 1000 + 5;

const word = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;

function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'pi_1',
    chain: 'monad',
    network: 'public',
    kind: 'PAY',
    destination: DEST,
    amount: '2.5',
    asset: 'USDC',
    assetIssuer: TOKEN,
    assetDecimals: 6,
    chainCursor: '100',
    createdAt: CREATED,
    ...over,
  } as PaymentIntent;
}

function tx(over: Partial<EvmTransaction> = {}): EvmTransaction {
  return {
    hash: HASH,
    from: PAYER.toLowerCase(),
    to: TOKEN.toLowerCase(),
    value: '0x0',
    input: '0x',
    blockNumber: '0x65',
    ...over,
  };
}

function transferLog(value: bigint, to = DEST, token = TOKEN) {
  return {
    address: token.toLowerCase(),
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYER), addressTopic(to)],
    data: word(value),
    blockNumber: '0x65',
    transactionHash: HASH,
    logIndex: '0x0',
  };
}

function receipt(over: Partial<EvmReceipt> = {}): EvmReceipt {
  return {
    transactionHash: HASH,
    from: PAYER,
    to: TOKEN,
    status: '0x1',
    blockNumber: '0x65',
    logs: [transferLog(2_500_000n)],
    ...over,
  };
}

function make(opts: {
  tx?: EvmTransaction | null;
  receipt?: EvmReceipt | null;
  head?: bigint;
  logs?: unknown[][];
  timestamp?: number;
}) {
  const getLogs = jest.fn();
  for (const page of opts.logs ?? []) getLogs.mockResolvedValueOnce(page);
  getLogs.mockResolvedValue([]);
  const rpc = {
    getTransaction: jest
      .fn()
      .mockResolvedValue(opts.tx === undefined ? tx() : opts.tx),
    getReceipt: jest
      .fn()
      .mockResolvedValue(opts.receipt === undefined ? receipt() : opts.receipt),
    blockTimestamp: jest.fn().mockResolvedValue(opts.timestamp ?? AFTER),
    blockNumber: jest.fn().mockResolvedValue(opts.head ?? 100n),
    logBlockRange: jest.fn().mockReturnValue(100),
    getLogs,
  };
  return { verifier: new EvmVerifierService(rpc as never), rpc };
}

describe('EvmVerifierService.verifyByHash', () => {
  it('settles an ERC-20 Transfer to the destination for exactly the amount', async () => {
    const { verifier } = make({});
    await expect(verifier.verifyByHash(intent(), HASH)).resolves.toEqual({
      valid: true,
      txHash: HASH,
      payer: PAYER,
    });
  });

  it('refuses a transfer of another amount, to another payee or of another token', async () => {
    for (const log of [
      transferLog(2_499_999n),
      transferLog(2_500_000n, PAYER),
      transferLog(2_500_000n, DEST, PAYER),
    ]) {
      const { verifier } = make({ receipt: receipt({ logs: [log] }) });
      expect((await verifier.verifyByHash(intent(), HASH)).valid).toBe(false);
    }
  });

  it('refuses a payment that landed before the intent existed', async () => {
    const { verifier } = make({ timestamp: CREATED.getTime() / 1000 - 3600 });
    expect((await verifier.verifyByHash(intent(), HASH)).reason).toMatch(
      /predates/,
    );
  });

  it('recognises the payer’s own reverted transfer() call as failedOnChain', async () => {
    const input =
      ERC20_TRANSFER_SELECTOR +
      addressTopic(DEST).slice(2) +
      word(2_500_000n).slice(2);
    const { verifier } = make({
      tx: tx({ input }),
      receipt: receipt({ status: '0x0', logs: [] }),
    });
    await expect(verifier.verifyByHash(intent(), HASH)).resolves.toMatchObject({
      valid: false,
      failedOnChain: true,
    });
  });

  it('settles a native MON payment by the transaction’s to and value', async () => {
    const { verifier } = make({
      tx: tx({
        to: DEST.toLowerCase(),
        value: `0x${(25n * 10n ** 17n).toString(16)}`,
      }),
      receipt: receipt({ logs: [] }),
    });
    const result = await verifier.verifyByHash(
      intent({ asset: 'native', assetIssuer: null, assetDecimals: null }),
      HASH,
    );
    expect(result).toMatchObject({ valid: true, payer: PAYER });
  });

  it('answers an unknown hash as a mismatch', async () => {
    const { verifier } = make({ tx: null, receipt: null });
    expect((await verifier.verifyByHash(intent(), HASH)).valid).toBe(false);
  });
});

describe('EvmVerifierService.findMatchingPayment', () => {
  it('scans Transfer logs to the destination from the block after the cursor', async () => {
    const { verifier, rpc } = make({
      head: 350n,
      logs: [[], [transferLog(2_500_000n)]],
    });
    const result = await verifier.findMatchingPayment(intent());
    expect(result).toMatchObject({ valid: true, txHash: HASH, payer: PAYER });
    expect(rpc.getLogs).toHaveBeenNthCalledWith(1, 'monad', 'public', {
      address: TOKEN,
      topics: [ERC20_TRANSFER_TOPIC, null, addressTopic(DEST)],
      fromBlock: 101n,
      toBlock: 200n,
    });
    expect(rpc.getLogs.mock.calls[1][2]).toMatchObject({
      fromBlock: 201n,
      toBlock: 300n,
    });
  });

  it('reports where it stopped, bounded per tick, when nothing matched', async () => {
    const { verifier, rpc } = make({ head: 10_000n });
    const result = await verifier.findMatchingPayment(intent());
    expect(result).toMatchObject({ valid: false, nextCursor: '600' });
    expect(rpc.getLogs).toHaveBeenCalledTimes(5);
  });

  it('never scans for a native MON payment: validate settles those', async () => {
    const { verifier, rpc } = make({});
    const result = await verifier.findMatchingPayment(
      intent({ asset: 'native', assetIssuer: null }),
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/validate/);
    expect(rpc.getLogs).not.toHaveBeenCalled();
  });
});

describe('EvmVerifierService with a deposit address', () => {
  const DEPOSIT = '0xC830d264C14ebDB31cdEa0Fb6f83C5b0D8EEc52F';
  const native = (over: Partial<PaymentIntent> = {}) =>
    intent({
      asset: 'native',
      assetIssuer: null,
      assetDecimals: null,
      amount: '1',
      chainReference: DEPOSIT,
      ...over,
    });
  const payTo = (to: string, wei: bigint) =>
    make({
      tx: tx({ to: to.toLowerCase(), value: `0x${wei.toString(16)}` }),
      receipt: receipt({ logs: [] }),
    });

  it('settles a native MON payment to the deposit address, at or above the amount', async () => {
    for (const wei of [10n ** 18n, 2n * 10n ** 18n]) {
      const { verifier } = payTo(DEPOSIT, wei);
      expect((await verifier.verifyByHash(native(), HASH)).valid).toBe(true);
    }
    const { verifier } = payTo(DEPOSIT, 10n ** 18n - 1n);
    expect((await verifier.verifyByHash(native(), HASH)).valid).toBe(false);
  });

  it('does not count a payment made to the merchant directly', async () => {
    const { verifier } = payTo(DEST, 10n ** 18n);
    expect((await verifier.verifyByHash(native(), HASH)).valid).toBe(false);
  });

  it('settles any positive amount for an open intent', async () => {
    const { verifier } = payTo(DEPOSIT, 1n);
    expect(
      (await verifier.verifyByHash(native({ amount: null }), HASH)).valid,
    ).toBe(true);
  });

  it('leaves discovery to the deposit forwarder: no log scan', async () => {
    const { verifier, rpc } = make({});
    const result = await verifier.findMatchingPayment(native());
    expect(result.valid).toBe(false);
    expect(rpc.getLogs).not.toHaveBeenCalled();
    expect(rpc.blockNumber).not.toHaveBeenCalled();
  });
});
