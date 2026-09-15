import { SETTLEMENT_MAX_ROWS_PER_CONSUMER } from '@/observer/observer.constants';
import {
  liquiditySettlementResource,
  swapSettlementResource,
} from '@/observer/settlement-resources';

function makePrisma() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    swap: { findMany: jest.fn().mockResolvedValue([]) },
    liquidityPoolOperation: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

const cases = [
  {
    name: 'swaps',
    build: swapSettlementResource,
    table: 'swap',
    delegate: 'swap',
    other: 'liquidityPoolOperation',
    label: 'swap',
  },
  {
    name: 'liquidity pool operations',
    build: liquiditySettlementResource,
    table: 'liquidity_pool_operation',
    delegate: 'liquidityPoolOperation',
    other: 'swap',
    label: 'LP operation',
  },
] as const;

/**
 * The two adapters differ only in their table, their service and their noun;
 * these pin that each one really is confined to its own.
 */
describe.each(cases)(
  'settlement resource for $name',
  ({ build, table, delegate, other, label }) => {
    it('logs under its own noun and finalizes through the service it was given', () => {
      const domain = { finalizeSucceeded: jest.fn() } as any;

      const resource = build(makePrisma() as any, domain);

      expect(resource.label).toBe(label);
      expect(resource.transitions).toBe(domain);
    });

    it('ranks its own table per consumer, capped, within the batch', async () => {
      const prisma = makePrisma();

      await build(prisma as any, {} as any).selectInFlight(25);

      const [sql, ...values] = prisma.$queryRaw.mock.calls[0];
      const text = (sql as string[]).join('?');
      expect(text).toContain(`FROM "${table}"`);
      expect(text).toMatch(
        /PARTITION BY "consumerId" ORDER BY "createdAt", "id"/,
      );
      expect(text).toMatch(/"status" IN \('PENDING', 'SUBMITTED'\)/);
      expect(text).toMatch(/ORDER BY "rank", "createdAt", "id"/);
      expect(values).toEqual([SETTLEMENT_MAX_ROWS_PER_CONSUMER, 25]);
    });

    it('re-reads only the dealt rows still in flight, oldest first, with their consumer', async () => {
      const prisma = makePrisma();
      prisma.$queryRaw.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
      const reread = [{ id: 'a' }];
      prisma[delegate].findMany.mockResolvedValue(reread);

      const rows = await build(prisma as any, {} as any).selectInFlight(25);

      expect(rows).toBe(reread);
      expect(prisma[delegate].findMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['a', 'b'] },
          status: { in: ['PENDING', 'SUBMITTED'] },
        },
        include: { consumer: true },
        orderBy: { createdAt: 'asc' },
      });
      expect(prisma[other].findMany).not.toHaveBeenCalled();
    });

    it('reads nothing further when nothing was dealt', async () => {
      const prisma = makePrisma();

      const rows = await build(prisma as any, {} as any).selectInFlight(25);

      expect(rows).toEqual([]);
      expect(prisma.swap.findMany).not.toHaveBeenCalled();
      expect(prisma.liquidityPoolOperation.findMany).not.toHaveBeenCalled();
    });
  },
);
