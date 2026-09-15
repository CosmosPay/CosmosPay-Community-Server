import { Keypair } from '@stellar/stellar-sdk';
import { toStroops } from '@/swaps/swap-math';
import { LpCostBasisService } from '@/liquidity-pools/lp-cost-basis.service';

const TX_HASH = 'ab'.repeat(32);
const POOL_ID = 'dd'.repeat(32);
const SOURCE = Keypair.random().publicKey();
const USDC_ISSUER = Keypair.random().publicKey();

function matchesWhere(row: any, where: any): boolean {
  for (const key of ['id', 'kind', 'source', 'poolId', 'network', 'status']) {
    if (where[key] !== undefined && where[key] !== row[key]) return false;
  }
  if (where.sharesReceived === null && row.sharesReceived != null) return false;
  return true;
}

/** Just the two calls the service makes, over rows a test can inspect. */
function createPrisma() {
  const rows: any[] = [];
  return {
    rows,
    liquidityPoolOperation: {
      findMany: jest.fn(async ({ where, select }: any) =>
        rows
          .filter((r) => matchesWhere(r, where))
          .map((r) => {
            const out: any = {};
            for (const k of Object.keys(select)) if (select[k]) out[k] = r[k];
            return out;
          }),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const matched = rows.filter((r) => matchesWhere(r, where));
        for (const row of matched) Object.assign(row, data);
        return { count: matched.length };
      }),
    },
  };
}

function makeStellar() {
  const effectsCall = jest.fn().mockResolvedValue({
    records: [
      {
        type: 'liquidity_pool_deposited',
        shares_received: '100',
        reserves_deposited: [
          { asset: 'native', amount: '1000' },
          { asset: `USDC:${USDC_ISSUER}`, amount: '100' },
        ],
      },
    ],
  });
  return {
    server: jest.fn().mockReturnValue({
      effects: () => ({ forTransaction: () => ({ call: effectsCall }) }),
    }),
    effectsCall,
  };
}

function depositRow(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'lp_1',
    consumerId: 'c1',
    kind: 'DEPOSIT',
    status: 'PENDING',
    network: 'testnet',
    source: SOURCE,
    poolId: POOL_ID,
    assetA: 'native',
    assetAIssuer: null,
    assetB: 'USDC',
    assetBIssuer: USDC_ISSUER,
    amountA: '1000',
    amountB: '100',
    shares: null,
    sharesReceived: null,
    settledAmountA: null,
    settledAmountB: null,
    txHash: TX_HASH,
    ...overrides,
  };
}

describe('LpCostBasisService', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let stellar: ReturnType<typeof makeStellar>;
  let basis: LpCostBasisService;

  beforeEach(() => {
    prisma = createPrisma();
    stellar = makeStellar();
    basis = new LpCostBasisService(prisma as never, stellar as never);
  });

  describe('costBasis', () => {
    it('counts a settled deposit toward remaining shares and cost', async () => {
      prisma.rows.push(
        depositRow({
          status: 'SUCCEEDED',
          sharesReceived: '100',
          settledAmountA: '1000',
          settledAmountB: '100',
        }),
      );
      const position = await basis.costBasis(SOURCE, POOL_ID, 'testnet');
      expect(position.depositedShares).toBe(toStroops('100'));
      expect(position.remainingShares).toBe(toStroops('100'));
      expect(position.costA).toBe(toStroops('1000'));
      expect(position.costB).toBe(toStroops('100'));
    });

    it('does not count FAILED deposits — a degraded row would lose the basis', async () => {
      prisma.rows.push(
        depositRow({
          status: 'FAILED',
          sharesReceived: '100',
          settledAmountA: '1000',
          settledAmountB: '100',
        }),
      );
      const position = await basis.costBasis(SOURCE, POOL_ID, 'testnet');
      expect(position.remainingShares).toBe(0n);
      expect(position.costA).toBe(0n);
    });

    it('subtracts a succeeded withdraw from remaining shares (partial)', async () => {
      prisma.rows.push(
        depositRow({
          status: 'SUCCEEDED',
          sharesReceived: '100',
          settledAmountA: '1000',
          settledAmountB: '100',
        }),
        depositRow({
          id: 'lp_w1',
          kind: 'WITHDRAW',
          status: 'SUCCEEDED',
          shares: '40',
          sharesReceived: null,
          amountA: '396',
          amountB: '39.6',
        }),
      );
      const position = await basis.costBasis(SOURCE, POOL_ID, 'testnet');
      expect(position.depositedShares).toBe(toStroops('100'));
      expect(position.remainingShares).toBe(toStroops('60'));
    });

    it('is keyed on the Stellar account, not on the organization that deposited', async () => {
      // Scoping by consumer made the commission opt-out: deposit under one
      // organization, withdraw under a second, and the basis lookup found none.
      prisma.rows.push(
        depositRow({
          id: 'lp_org_a',
          consumerId: 'c1',
          status: 'SUCCEEDED',
          sharesReceived: '100',
          settledAmountA: '1000',
          settledAmountB: '100',
        }),
        depositRow({
          id: 'lp_org_b',
          consumerId: 'c2',
          status: 'SUCCEEDED',
          sharesReceived: '50',
          settledAmountA: '500',
          settledAmountB: '50',
        }),
      );
      const position = await basis.costBasis(SOURCE, POOL_ID, 'testnet');
      expect(position.depositedShares).toBe(toStroops('150'));
      expect(prisma.liquidityPoolOperation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            source: SOURCE,
            poolId: POOL_ID,
            network: 'testnet',
            status: 'SUCCEEDED',
          },
        }),
      );
    });

    it('does not count a deposit whose basis was never captured', async () => {
      // A position opened without a recorded basis is taxed nothing.
      prisma.rows.push(depositRow({ status: 'SUCCEEDED' }));
      const position = await basis.costBasis(SOURCE, POOL_ID, 'testnet');
      expect(position.depositedShares).toBe(0n);
      expect(position.remainingShares).toBe(0n);
    });
  });

  describe('captureDepositBasis', () => {
    it('writes sharesReceived and settled amounts for a SUCCEEDED deposit', async () => {
      const row = depositRow({ status: 'SUCCEEDED' });
      prisma.rows.push(row);
      await basis.captureDepositBasis(row);
      expect(row.sharesReceived).toBe('100');
      expect(row.settledAmountA).toBe('1000');
      expect(row.settledAmountB).toBe('100');
    });

    it('does not overwrite an already-captured cost basis', async () => {
      const row = depositRow({
        status: 'SUCCEEDED',
        sharesReceived: '100',
        settledAmountA: '1000',
        settledAmountB: '100',
      });
      prisma.rows.push(row);
      stellar.effectsCall.mockResolvedValue({
        records: [
          {
            type: 'liquidity_pool_deposited',
            shares_received: '999',
            reserves_deposited: [
              { asset: 'native', amount: '1' },
              { asset: `USDC:${USDC_ISSUER}`, amount: '1' },
            ],
          },
        ],
      });
      await basis.captureDepositBasis(row);
      expect(row.sharesReceived).toBe('100');
      expect(row.settledAmountA).toBe('1000');
      expect(stellar.effectsCall).not.toHaveBeenCalled();
    });

    it('does not write a cost basis onto a FAILED row', async () => {
      const row = depositRow({ status: 'FAILED' });
      prisma.rows.push(row);
      await basis.captureDepositBasis(row);
      expect(row.sharesReceived).toBeNull();
      expect(stellar.effectsCall).not.toHaveBeenCalled();
    });

    it('captures nothing for a withdrawal', async () => {
      const row = depositRow({ kind: 'WITHDRAW', status: 'SUCCEEDED' });
      prisma.rows.push(row);
      await basis.captureDepositBasis(row);
      expect(row.sharesReceived).toBeNull();
      expect(stellar.effectsCall).not.toHaveBeenCalled();
    });

    it('falls back to the requested amount for a reserve the effect omits', async () => {
      const row = depositRow({ status: 'SUCCEEDED' });
      prisma.rows.push(row);
      stellar.effectsCall.mockResolvedValue({
        records: [
          {
            type: 'liquidity_pool_deposited',
            shares_received: '90',
            reserves_deposited: [{ asset: 'native', amount: '999' }],
          },
        ],
      });
      await basis.captureDepositBasis(row);
      expect(row.sharesReceived).toBe('90');
      expect(row.settledAmountA).toBe('999');
      expect(row.settledAmountB).toBe('100');
    });

    it('leaves the basis uncaptured, without throwing, when Horizon cannot be read', async () => {
      // Best-effort: the observer's backfill retries it on a later tick.
      const row = depositRow({ status: 'SUCCEEDED' });
      prisma.rows.push(row);
      stellar.effectsCall.mockRejectedValue(new Error('socket hang up'));
      await expect(basis.captureDepositBasis(row)).resolves.toBeUndefined();
      expect(row.sharesReceived).toBeNull();
      expect(prisma.liquidityPoolOperation.updateMany).not.toHaveBeenCalled();
    });
  });
});
