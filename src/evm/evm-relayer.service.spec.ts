import { secp256k1 } from '@noble/curves/secp256k1.js';
import { EvmRelayer } from '@/evm/evm-relayer.service';
import { addressOfSecretKey } from '@/evm/evm-transaction';
import { bytesToHex } from '@/evm/rlp';

const KEY = secp256k1.utils.randomSecretKey();
const CALL = {
  to: '0x4e59b44847b379578588920ca78fbf26c0b4956c',
  data: '0xdead',
};

function make(key = bytesToHex(KEY)) {
  const config = { get: () => ({ relayerPrivateKey: key }) };
  let nonce = 0n;
  const rpc = {
    chainId: () => 10143,
    pendingNonce: jest.fn(async () => nonce),
    feeData: jest.fn().mockResolvedValue({
      maxFeePerGas: 200n * 10n ** 9n,
      maxPriorityFeePerGas: 2n * 10n ** 9n,
    }),
    estimateGas: jest.fn().mockResolvedValue(400_000n),
    sendRawTransaction: jest.fn(async (_c: string, _n: string, raw: string) => {
      nonce += 1n;
      return raw;
    }),
  };
  return { relayer: new EvmRelayer(config as never, rpc as never), rpc };
}

describe('EvmRelayer', () => {
  it('is off without a key, and names its address with one', () => {
    expect(make('').relayer.isEnabled('monad')).toBe(false);
    const { relayer } = make();
    expect(relayer.isEnabled('monad')).toBe(true);
    expect(relayer.address('monad')).toBe(addressOfSecretKey(KEY));
  });

  it('bids a gas limit just over the estimate — Monad bills the whole limit', async () => {
    const { relayer, rpc } = make();
    await relayer.send('monad', 'testnet', CALL);
    expect(rpc.estimateGas).toHaveBeenCalledWith('monad', 'testnet', {
      from: addressOfSecretKey(KEY),
      ...CALL,
    });
    // 400k × 1.15 = 460k = 0x0704e0, RLP-encoded in the raw transaction.
    expect(rpc.sendRawTransaction.mock.calls[0][2]).toContain('830704e0');
  });

  it('sends one transaction at a time, so no two read the same nonce', async () => {
    const { relayer, rpc } = make();
    const hashes = await Promise.all([
      relayer.send('monad', 'testnet', CALL),
      relayer.send('monad', 'testnet', CALL),
      relayer.send('monad', 'testnet', CALL),
    ]);
    expect(new Set(hashes).size).toBe(3);
    expect(rpc.pendingNonce.mock.results.length).toBe(3);
  });

  it('keeps sending after one send fails', async () => {
    const { relayer, rpc } = make();
    rpc.sendRawTransaction.mockRejectedValueOnce(new Error('pool full'));
    await expect(relayer.send('monad', 'testnet', CALL)).rejects.toThrow(
      'pool full',
    );
    await expect(relayer.send('monad', 'testnet', CALL)).resolves.toMatch(
      /^0x[0-9a-f]{64}$/,
    );
  });
});
