import type { PaymentIntent } from '@generated/prisma/client';
import { SolanaVerifierService } from '@/payment-intents/solana-verifier.service';
import type { SolanaTransaction } from '@/solana/solana-rpc.client';

const DEST = 'DestWa11et1111111111111111111111111111111111';
const PAYER = 'PayerWa11et111111111111111111111111111111111';
const REF = 'Ref1111111111111111111111111111111111111111';
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CREATED = new Date('2026-09-29T12:00:00Z');

function intent(over: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'pi_1',
    chain: 'solana',
    network: 'testnet',
    kind: 'PAY',
    destination: DEST,
    amount: '1.5',
    asset: 'native',
    assetIssuer: null,
    assetDecimals: null,
    chainReference: REF,
    createdAt: CREATED,
    ...over,
  } as PaymentIntent;
}

/** A SOL transfer PAYER → DEST of `lamports`, carrying `keys` (the reference by default). */
function solTransfer(
  lamports: number,
  over: { err?: unknown; blockTime?: number | null; keys?: string[] } = {},
): SolanaTransaction {
  const keys = over.keys ?? [PAYER, DEST, REF];
  return {
    slot: 1,
    blockTime:
      over.blockTime === undefined
        ? CREATED.getTime() / 1000 + 5
        : over.blockTime,
    meta: {
      err: over.err ?? null,
      preBalances: keys.map((k) => (k === PAYER ? 10_000_000_000 : 0)),
      postBalances: keys.map((k) =>
        k === DEST && !over.err
          ? lamports
          : k === PAYER
            ? 10_000_000_000 - lamports
            : 0,
      ),
    },
    transaction: {
      signatures: ['sig'],
      message: {
        accountKeys: keys.map((pubkey) => ({
          pubkey,
          signer: pubkey === PAYER,
          writable: pubkey !== REF,
        })),
      },
    },
  };
}

function make(tx: SolanaTransaction | null, signatures: unknown[] = []) {
  const rpc = {
    getTransaction: jest.fn().mockResolvedValue(tx),
    getSignaturesForAddress: jest.fn().mockResolvedValue(signatures),
  };
  return { verifier: new SolanaVerifierService(rpc as never), rpc };
}

describe('SolanaVerifierService.verifyByHash', () => {
  it('settles a SOL transfer of exactly the amount that carries the reference', async () => {
    const { verifier } = make(solTransfer(1_500_000_000));
    await expect(verifier.verifyByHash(intent(), 'sig')).resolves.toEqual({
      valid: true,
      txHash: 'sig',
      payer: PAYER,
    });
  });

  it('refuses a transfer without the intent’s reference key', async () => {
    const { verifier } = make(
      solTransfer(1_500_000_000, { keys: [PAYER, DEST] }),
    );
    const result = await verifier.verifyByHash(intent(), 'sig');
    expect(result.valid).toBe(false);
    expect(result.failedOnChain).toBeUndefined();
  });

  it('refuses the wrong amount and an older transaction', async () => {
    let { verifier } = make(solTransfer(1_400_000_000));
    expect((await verifier.verifyByHash(intent(), 'sig')).valid).toBe(false);

    ({ verifier } = make(
      solTransfer(1_500_000_000, {
        blockTime: CREATED.getTime() / 1000 - 3600,
      }),
    ));
    expect((await verifier.verifyByHash(intent(), 'sig')).reason).toMatch(
      /predates/,
    );
  });

  it('reports the payer’s own failed attempt as failedOnChain', async () => {
    const { verifier } = make(
      solTransfer(1_500_000_000, { err: { InstructionError: [0, 'x'] } }),
    );
    const result = await verifier.verifyByHash(intent(), 'sig');
    expect(result).toMatchObject({ valid: false, failedOnChain: true });
  });

  it('answers an unknown signature as a mismatch', async () => {
    const { verifier } = make(null);
    expect((await verifier.verifyByHash(intent(), 'sig')).valid).toBe(false);
  });

  it('settles an SPL transfer from the destination’s token balance, ATA created in the same transaction', async () => {
    const tx = solTransfer(0, { keys: [PAYER, 'DestAta', REF] });
    tx.meta!.preTokenBalances = [];
    tx.meta!.postTokenBalances = [
      {
        accountIndex: 1,
        mint: MINT,
        owner: DEST,
        uiTokenAmount: { amount: '2500000', decimals: 6 },
      },
    ];
    const { verifier } = make(tx);
    const result = await verifier.verifyByHash(
      intent({
        asset: 'USDC',
        assetIssuer: MINT,
        assetDecimals: 6,
        amount: '2.5',
      }),
      'sig',
    );
    expect(result).toMatchObject({ valid: true, payer: PAYER });
  });

  it('accepts any positive amount for an open intent', async () => {
    const { verifier } = make(solTransfer(7));
    expect(
      (await verifier.verifyByHash(intent({ amount: null }), 'sig')).valid,
    ).toBe(true);
  });
});

describe('SolanaVerifierService.findMatchingPayment', () => {
  it('walks the reference key’s signatures oldest first and settles on the first that pays', async () => {
    const { verifier, rpc } = make(solTransfer(1_500_000_000), [
      { signature: 'newer', err: null },
      { signature: 'failed', err: { x: 1 } },
      { signature: 'older', err: null },
    ]);
    const result = await verifier.findMatchingPayment(intent());
    expect(result).toMatchObject({ valid: true, txHash: 'older' });
    // The failed one is never fetched, and the reference is what was asked about.
    expect(rpc.getTransaction).toHaveBeenCalledTimes(1);
    expect(rpc.getSignaturesForAddress).toHaveBeenCalledWith(
      'testnet',
      REF,
      20,
    );
  });

  it('finds nothing when the reference has no transactions yet', async () => {
    const { verifier } = make(null, []);
    expect((await verifier.findMatchingPayment(intent())).valid).toBe(false);
  });
});
