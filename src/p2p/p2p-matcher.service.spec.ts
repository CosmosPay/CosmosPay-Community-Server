import { decodeSignedEip1559 } from '@/evm/evm-transaction';
import { P2pCallReverted } from '@/p2p/p2p-chain.client';
import { P2pMatcherService } from '@/p2p/p2p-matcher.service';
import type { P2pDeployment } from '@/p2p/p2p-networks.service';

const KEY = new Uint8Array(32).fill(9);
const MATCHER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';

const D: P2pDeployment = {
  tier: 'testnet',
  network: 'base',
  name: 'Base',
  chainId: 84532,
  contract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  deployBlock: 1n,
  rpcUrl: 'http://node',
  tokens: [],
  confirmations: 2,
  logBlockRange: 500,
};

function setup(lastNonce: bigint | null, pending: bigint) {
  const calls: string[] = [];
  const rows: Record<string, unknown>[] = [];
  const tx = {
    $executeRaw: jest.fn(() => {
      calls.push('lock');
      return Promise.resolve(1);
    }),
    p2pMatcherTx: {
      findFirst: jest.fn(() =>
        Promise.resolve(lastNonce === null ? null : { nonce: lastNonce }),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        calls.push('record');
        const row = { id: 'tx1', ...data };
        rows.push(row);
        return Promise.resolve({ id: row.id, hash: data.hash, raw: data.raw });
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    p2pMatcherTx: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const chain = {
    estimateGas: jest.fn(() => {
      calls.push('simulate');
      return Promise.resolve(100_000n);
    }),
    feeData: jest.fn().mockResolvedValue({
      maxFeePerGas: 2_000n,
      maxPriorityFeePerGas: 1_000n,
    }),
    pendingNonce: jest.fn().mockResolvedValue(pending),
    sendRawTransaction: jest.fn(() => {
      calls.push('broadcast');
      return Promise.resolve();
    }),
  };
  const networks = {
    matcherKey: () => KEY,
    matcherAddress: () => MATCHER,
    timeoutMs: () => 1000,
  };
  const service = new P2pMatcherService(
    prisma as never,
    networks as never,
    chain as never,
  );
  return { service, calls, rows, chain, prisma };
}

describe('P2pMatcherService', () => {
  it('simulates, then signs and records under the lock, then broadcasts', async () => {
    const { service, calls, rows } = setup(null, 4n);
    const hash = await service.send(D, {
      kind: 'open',
      orderId: 'o1',
      data: '0xabcdef',
    });
    expect(calls).toEqual(['simulate', 'lock', 'record', 'broadcast']);
    const row = rows[0];
    expect(row).toMatchObject({ kind: 'open', orderId: 'o1', nonce: 4n, hash });
    const decoded = decodeSignedEip1559(row.raw as string);
    expect(decoded).toMatchObject({
      chainId: 84532,
      nonce: 4n,
      to: D.contract,
      data: '0xabcdef',
      gasLimit: 130_000n,
    });
  });

  it('takes the next nonce after the last one it recorded, even when the node lags', async () => {
    const { service, rows } = setup(9n, 3n);
    await service.send(D, { kind: 'markPaid', orderId: 'o1', data: '0x01' });
    expect(rows[0].nonce).toBe(10n);
  });

  it('signs nothing when the contract would revert', async () => {
    const { service, chain, rows } = setup(null, 0n);
    chain.estimateGas.mockRejectedValueOnce(
      new P2pCallReverted('InsufficientBalance', 'InsufficientBalance'),
    );
    await expect(
      service.send(D, { kind: 'open', orderId: 'o1', data: '0x01' }),
    ).rejects.toBeInstanceOf(P2pCallReverted);
    expect(rows).toHaveLength(0);
  });

  it('keeps a recorded transaction when the broadcast fails: the follower resends it', async () => {
    const { service, chain, prisma, rows } = setup(null, 0n);
    chain.sendRawTransaction.mockRejectedValueOnce(new Error('node down'));
    await expect(
      service.send(D, { kind: 'cancel', orderId: 'o1', data: '0x01' }),
    ).resolves.toMatch(/^0x[0-9a-f]{64}$/);
    expect(rows).toHaveLength(1);
    expect(prisma.p2pMatcherTx.updateMany).toHaveBeenCalledWith({
      where: { id: 'tx1' },
      data: { lastError: 'node down' },
    });
  });
});
