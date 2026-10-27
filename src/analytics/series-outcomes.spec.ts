import {
  CrossChainSwapStatus,
  SwapStatus,
  Usdt0TransferStatus,
} from '@generated/prisma/client';
import {
  CHAIN_SWAP_OUTCOMES,
  CROSS_CHAIN_SWAP_OUTCOMES,
  LIQUIDITY_OPERATION_OUTCOMES,
  SWAP_OUTCOMES,
  USDT0_TRANSFER_OUTCOMES,
  type SeriesOutcome,
} from '@/analytics/analytics.constants';
import {
  outcomeCase,
  statusesFor,
  statusIn,
} from '@/analytics/series-outcomes';

/**
 * What the dashboard calls succeeded, failed and in progress for each model the series counts.
 * The `Record` types already refuse a missing status at compile time; these pin the decisions,
 * so moving a status to another outcome is a visible change to this file.
 */
describe('series outcomes', () => {
  const swapLike = {
    'Stellar DEX swaps': SWAP_OUTCOMES,
    'Solana and Monad swaps': CHAIN_SWAP_OUTCOMES,
    'liquidity operations': LIQUIDITY_OPERATION_OUTCOMES,
  };

  it.each(Object.entries(swapLike))(
    'maps every SwapStatus of %s: settled, given up on, or still moving',
    (_, outcomes) => {
      expect(Object.keys(outcomes).sort()).toEqual(
        Object.values(SwapStatus).sort(),
      );
      expect(statusesFor(outcomes, 'succeeded')).toEqual(['SUCCEEDED']);
      expect(statusesFor(outcomes, 'failed')).toEqual(['FAILED', 'EXPIRED']);
      expect(statusesFor(outcomes, 'inProgress')).toEqual([
        'PENDING',
        'SUBMITTED',
      ]);
    },
  );

  it('maps every CrossChainSwapStatus, a refund being a swap that did not happen', () => {
    expect(Object.keys(CROSS_CHAIN_SWAP_OUTCOMES).sort()).toEqual(
      Object.values(CrossChainSwapStatus).sort(),
    );
    expect(statusesFor(CROSS_CHAIN_SWAP_OUTCOMES, 'succeeded')).toEqual([
      'SUCCEEDED',
    ]);
    expect(statusesFor(CROSS_CHAIN_SWAP_OUTCOMES, 'failed')).toEqual([
      'REFUNDED',
      'FAILED',
      'EXPIRED',
    ]);
    expect(statusesFor(CROSS_CHAIN_SWAP_OUTCOMES, 'inProgress')).toEqual([
      'AWAITING_DEPOSIT',
      'DEPOSIT_DETECTED',
      'INCOMPLETE_DEPOSIT',
      'PROCESSING',
    ]);
  });

  it('maps every Usdt0TransferStatus: delivered, given up on, or still on its way', () => {
    expect(Object.keys(USDT0_TRANSFER_OUTCOMES).sort()).toEqual(
      Object.values(Usdt0TransferStatus).sort(),
    );
    expect(statusesFor(USDT0_TRANSFER_OUTCOMES, 'succeeded')).toEqual([
      'DELIVERED',
    ]);
    expect(statusesFor(USDT0_TRANSFER_OUTCOMES, 'failed')).toEqual([
      'FAILED',
      'EXPIRED',
    ]);
    expect(statusesFor(USDT0_TRANSFER_OUTCOMES, 'inProgress')).toEqual([
      'PENDING',
      'SUBMITTED',
    ]);
  });

  it('writes the predicate a FILTER needs, from the table and nothing else', () => {
    expect(statusIn(LIQUIDITY_OPERATION_OUTCOMES, 'failed').sql).toBe(
      `"status" IN ('FAILED', 'EXPIRED')`,
    );
    expect(statusIn(LIQUIDITY_OPERATION_OUTCOMES, 'failed').values).toEqual([]);
    // `IN ()` is a syntax error; an outcome no status maps to matches nothing.
    const allSettled: Record<string, SeriesOutcome> = { DONE: 'succeeded' };
    expect(statusIn(allSettled, 'failed').sql).toBe('FALSE');
  });

  it('labels each row with its outcome in one CASE, with no ELSE to guess with', () => {
    expect(outcomeCase(CROSS_CHAIN_SWAP_OUTCOMES).sql).toBe(
      `CASE WHEN "status" IN ('SUCCEEDED') THEN 'succeeded' ` +
        `WHEN "status" IN ('REFUNDED', 'FAILED', 'EXPIRED') THEN 'failed' ` +
        `WHEN "status" IN ('AWAITING_DEPOSIT', 'DEPOSIT_DETECTED', 'INCOMPLETE_DEPOSIT', 'PROCESSING') THEN 'inProgress' END`,
    );
    // An outcome with no status gets no arm rather than an empty `IN ()`.
    expect(outcomeCase({ DONE: 'succeeded', LOST: 'failed' }).sql).toBe(
      `CASE WHEN "status" IN ('DONE') THEN 'succeeded' WHEN "status" IN ('LOST') THEN 'failed' END`,
    );
  });

  it('refuses a label that is not a plain enum identifier, since it is spliced in as SQL', () => {
    const injected = {
      "SUCCEEDED') OR ('1' = '1": 'succeeded',
    } as Record<string, SeriesOutcome>;
    expect(() => statusIn(injected, 'succeeded')).toThrow(/Not an enum label/);
    expect(() => outcomeCase(injected)).toThrow(/Not an enum label/);
    expect(() => outcomeCase({})).toThrow(/maps no status/);
  });
});
