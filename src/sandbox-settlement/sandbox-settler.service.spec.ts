import type { PaymentDeposit } from '@generated/prisma/client';
import { addressOfSecretKey, decodeSignedEip1559 } from '@/evm/evm-transaction';
import { hexToBytes } from '@/evm/rlp';
import { erc20TransferCalldata } from '@/sandbox-settlement/sandbox-evm.client';
import { SandboxEvmLedger } from '@/sandbox-settlement/sandbox-evm.ledger';
import { SandboxLedgers } from '@/sandbox-settlement/sandbox-ledgers.service';
import { SANDBOX_NETWORKS } from '@/sandbox-settlement/sandbox-settlement.constants';
import { SandboxSettler } from '@/sandbox-settlement/sandbox-settler.service';

const TREASURY_KEY = '0x' + '07'.repeat(32);
const TREASURY = addressOfSecretKey(hexToBytes(TREASURY_KEY));
const ARB_USDC = '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d';
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const MERCHANT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const PAYER = '0x' + '1'.repeat(40);
const DEPOSIT_ADDRESS = '0x' + '2'.repeat(40);

function deposit(overrides: Partial<PaymentDeposit> = {}): PaymentDeposit {
  return {
    id: 'dep_1',
    intentId: 'pi_1',
    network: 'testnet',
    status: 'AWAITING_DEPOSIT',
    providerStatus: 'PENDING_DEPOSIT',
    originChain: 'arb',
    originAsset: 'USDC',
    originAssetId: `sandbox:arb:${ARB_USDC.toLowerCase()}`,
    originContract: ARB_USDC,
    originDecimals: 6,
    destinationChain: 'base',
    destinationAsset: 'USDC',
    destinationAssetId: `sandbox:base:${BASE_USDC.toLowerCase()}`,
    destinationContract: BASE_USDC,
    destinationDecimals: 6,
    amountIn: '25',
    minAmountIn: '25',
    amountOut: '25',
    feeBps: 0,
    feeAmount: '0',
    slippageBps: 0,
    recipient: MERCHANT,
    refundTo: PAYER,
    payerSessionId: 'ses_1',
    merchantFee: null,
    clientKey: 'k',
    depositAddress: DEPOSIT_ADDRESS,
    depositMemo: null,
    depositUri: null,
    amountOutPaid: null,
    refundedAmount: null,
    originTxHashes: null,
    destinationTxHashes: null,
    timeEstimateSeconds: 30,
    correlationId: "sandbox:m/44'/60'/7007'/1'/2'",
    quoteSignature: 'sandbox',
    quote: {},
    expiresAt: new Date(Date.now() + 20 * 60_000),
    lastCheckedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function build(
  balances: { deposit?: bigint; treasury?: bigint } = {},
  receipts: Record<string, { succeeded: boolean } | null> = {},
) {
  let rows: any[] = [];
  const prisma: any = {
    sandboxPayout: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(rows.filter((r) => r.depositId === where.depositId)),
      ),
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(
          rows.find(
            (r) =>
              r.depositId === where.depositId_kind.depositId &&
              r.kind === where.depositId_kind.kind,
          ) ?? null,
        ),
      ),
      create: jest.fn(({ data }: any) => {
        if (
          rows.some(
            (r) => r.depositId === data.depositId && r.kind === data.kind,
          )
        ) {
          return Promise.reject(
            Object.assign(new Error('unique'), { code: 'P2002' }),
          );
        }
        const row = { id: `pay_${rows.length + 1}`, status: 'SENT', ...data };
        rows.push(row);
        return Promise.resolve(row);
      }),
      update: jest.fn(({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return Promise.resolve(row);
      }),
    },
  };
  const chains = {
    network: (id: string) => (SANDBOX_NETWORKS as any)[id],
    erc20BalanceOf: jest.fn((_net: string, _token: string, owner: string) =>
      Promise.resolve(
        owner === TREASURY
          ? (balances.treasury ?? 10n ** 12n)
          : (balances.deposit ?? 0n),
      ),
    ),
    pendingNonce: jest.fn().mockResolvedValue(7n),
    feeData: jest
      .fn()
      .mockResolvedValue({ maxFeePerGas: 200n, maxPriorityFeePerGas: 100n }),
    estimateGas: jest.fn().mockResolvedValue(50_000n),
    sendRawTransaction: jest.fn().mockResolvedValue(undefined),
    receipt: jest.fn((_net: string, hash: string) =>
      Promise.resolve(hash in receipts ? receipts[hash] : null),
    ),
  };
  const config = {
    get: () => ({ treasuryPrivateKey: TREASURY_KEY }),
  } as never;
  const settler = new SandboxSettler(
    prisma,
    new SandboxLedgers(
      new SandboxEvmLedger(config, chains as never),
      {} as never,
      {} as never,
    ),
  );
  return {
    settler,
    prisma,
    chains,
    rows: () => rows,
    setRows: (r: any[]) => {
      rows = r;
    },
  };
}

describe('SandboxSettler', () => {
  it('reports nothing arrived as PENDING_DEPOSIT, a short deposit as INCOMPLETE_DEPOSIT', async () => {
    const empty = build({ deposit: 0n });
    await expect(empty.settler.observe(deposit())).resolves.toMatchObject({
      status: 'PENDING_DEPOSIT',
    });
    const short = build({ deposit: 24_000_000n });
    await expect(short.settler.observe(deposit())).resolves.toMatchObject({
      status: 'INCOMPLETE_DEPOSIT',
    });
    expect(short.chains.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('pays the merchant on the link test network from the treasury, recorded before the broadcast', async () => {
    const { settler, chains, rows, prisma } = build({ deposit: 25_000_000n });

    const status = await settler.observe(deposit());

    expect(status.status).toBe('PROCESSING');
    const [row] = rows();
    expect(row).toMatchObject({
      depositId: 'dep_1',
      kind: 'payout',
      network: 'base',
      token: BASE_USDC,
      recipient: MERCHANT,
      amount: '25000000',
      nonce: '7',
    });
    // Written first, broadcast after: a crash in between rebroadcasts these bytes.
    expect(
      prisma.sandboxPayout.create.mock.invocationCallOrder[0],
    ).toBeLessThan(chains.sendRawTransaction.mock.invocationCallOrder[0]);
    const tx = decodeSignedEip1559(row.raw);
    expect(tx).toMatchObject({
      chainId: 84532,
      nonce: 7n,
      value: 0n,
      data: erc20TransferCalldata(MERCHANT, 25_000_000n),
    });
    expect(tx.to.toLowerCase()).toBe(BASE_USDC.toLowerCase());
    expect(tx.from).toBe(TREASURY);
    expect(row.txHash).toBe(tx.hash);
  });

  it('follows a sent payout: rebroadcast until mined, then SUCCESS with the payout', async () => {
    const first = build({ deposit: 25_000_000n });
    await first.settler.observe(deposit());
    const [row] = first.rows();

    const pending = build({ deposit: 25_000_000n });
    pending.setRows([row]);
    await expect(pending.settler.observe(deposit())).resolves.toMatchObject({
      status: 'PROCESSING',
    });
    expect(pending.chains.sendRawTransaction).toHaveBeenCalledWith(
      'base',
      row.raw,
    );
    expect(pending.prisma.sandboxPayout.create).not.toHaveBeenCalled();

    const mined = build(
      { deposit: 25_000_000n },
      { [row.txHash]: { succeeded: true } },
    );
    mined.setRows([{ ...row }]);
    const status = await mined.settler.observe(deposit());
    expect(status).toMatchObject({
      status: 'SUCCESS',
      swapDetails: {
        amountOut: '25000000',
        amountOutFormatted: '25',
        destinationChainTxHashes: [
          {
            hash: row.txHash,
            explorerUrl: `https://sepolia.basescan.org/tx/${row.txHash}`,
          },
        ],
      },
    });
    expect(mined.rows()[0].status).toBe('CONFIRMED');
  });

  it('reports a reverted payout as FAILED', async () => {
    const first = build({ deposit: 25_000_000n });
    await first.settler.observe(deposit());
    const [row] = first.rows();
    const reverted = build({}, { [row.txHash]: { succeeded: false } });
    reverted.setRows([{ ...row }]);
    await expect(reverted.settler.observe(deposit())).resolves.toMatchObject({
      status: 'FAILED',
    });
    expect(reverted.rows()[0].status).toBe('FAILED');
  });

  it('waits, without sending, while the treasury cannot pay', async () => {
    const { settler, chains, rows } = build({
      deposit: 25_000_000n,
      treasury: 1n,
    });
    await expect(settler.observe(deposit())).resolves.toMatchObject({
      status: 'KNOWN_DEPOSIT_TX',
    });
    expect(rows()).toEqual([]);
    expect(chains.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('refunds what arrived after the deadline to the payer, on the origin network', async () => {
    const late = deposit({ expiresAt: new Date(Date.now() - 1000) });
    const { settler, rows } = build({ deposit: 5_000_000n });
    await expect(settler.observe(late)).resolves.toMatchObject({
      status: 'PROCESSING',
    });
    const [row] = rows();
    expect(row).toMatchObject({
      kind: 'refund',
      network: 'arb',
      token: ARB_USDC,
      recipient: PAYER,
      amount: '5000000',
    });
    expect(decodeSignedEip1559(row.raw).chainId).toBe(421614);

    const mined = build({}, { [row.txHash]: { succeeded: true } });
    mined.setRows([{ ...row }]);
    await expect(mined.settler.observe(late)).resolves.toMatchObject({
      status: 'REFUNDED',
      swapDetails: {
        refundedAmountFormatted: '5',
        destinationChainTxHashes: [],
      },
    });
  });

  it('never sends a second payout for one deposit', async () => {
    const { settler, chains, setRows, rows } = build({ deposit: 25_000_000n });
    await settler.observe(deposit());
    const sends = chains.sendRawTransaction.mock.calls.length;
    // Another tick that missed the first row: the unique index stops it.
    const again = build({ deposit: 25_000_000n });
    again.setRows([]);
    again.prisma.sandboxPayout.findMany.mockResolvedValueOnce([]);
    again.prisma.sandboxPayout.create.mockRejectedValueOnce(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    again.prisma.sandboxPayout.findUnique.mockResolvedValueOnce(rows()[0]);
    await again.settler.observe(deposit());
    expect(again.chains.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(again.chains.sendRawTransaction).toHaveBeenCalledWith(
      'base',
      rows()[0].raw,
    );
    expect(sends).toBe(1);
    setRows(rows());
  });
});

describe('SandboxSettler over any ledger', () => {
  function withLedger(ledger: Record<string, jest.Mock>) {
    const rows: any[] = [];
    const prisma: any = {
      sandboxPayout: {
        findMany: jest.fn(() => Promise.resolve(rows)),
        create: jest.fn(({ data }: any) => {
          const row = { id: `pay_${rows.length + 1}`, status: 'SENT', ...data };
          rows.push(row);
          return Promise.resolve(row);
        }),
        update: jest.fn(({ where, data }: any) => {
          Object.assign(
            rows.find((r) => r.id === where.id),
            data,
          );
          return Promise.resolve();
        }),
      },
    };
    const settler = new SandboxSettler(prisma, { for: () => ledger } as never);
    return { settler, rows };
  }

  it('readies a deposit still waiting for its money, and only before its deadline', async () => {
    const ledger = {
      received: jest.fn().mockResolvedValue(0n),
      prepareDeposit: jest.fn().mockResolvedValue(undefined),
    };
    const { settler } = withLedger(ledger);
    await expect(settler.observe(deposit())).resolves.toMatchObject({
      status: 'PENDING_DEPOSIT',
    });
    expect(ledger.prepareDeposit).toHaveBeenCalledTimes(1);
    await settler.observe(deposit({ expiresAt: new Date(Date.now() - 1) }));
    expect(ledger.prepareDeposit).toHaveBeenCalledTimes(1);
  });

  it('signs nothing while the ledger says the transfer is blocked', async () => {
    const ledger = {
      received: jest.fn().mockResolvedValue(25_000_000n),
      blocker: jest.fn().mockResolvedValue('the recipient has no trustline'),
      sign: jest.fn(),
      broadcast: jest.fn(),
    };
    const { settler, rows } = withLedger(ledger);
    await expect(settler.observe(deposit())).resolves.toMatchObject({
      status: 'KNOWN_DEPOSIT_TX',
    });
    expect(ledger.sign).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it('records the signed transfer before broadcasting it, then follows its outcome', async () => {
    const ledger = {
      received: jest.fn().mockResolvedValue(25_000_000n),
      blocker: jest.fn().mockResolvedValue(null),
      sign: jest
        .fn()
        .mockResolvedValue({ hash: 'H1', raw: 'RAW', nonce: '12' }),
      broadcast: jest.fn().mockResolvedValue(undefined),
      follow: jest.fn().mockResolvedValue('failed'),
      explorerTx: jest.fn((_n: string, h: string) => `https://x/${h}`),
    };
    const { settler, rows } = withLedger(ledger);
    await expect(settler.observe(deposit())).resolves.toMatchObject({
      status: 'PROCESSING',
    });
    expect(rows[0]).toMatchObject({ txHash: 'H1', raw: 'RAW', nonce: '12' });
    expect(ledger.broadcast).toHaveBeenCalledWith('base', 'RAW');
    // Expired unexecuted (or reverted): final, never signed again.
    await expect(settler.observe(deposit())).resolves.toMatchObject({
      status: 'FAILED',
    });
    expect(rows[0].status).toBe('FAILED');
    expect(ledger.sign).toHaveBeenCalledTimes(1);
  });
});
