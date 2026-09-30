import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import type { AdvisoryLockService } from '@/common/services/advisory-lock.service';
import type { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { PrismaService } from '@/prisma/prisma.service';
import { ChainSwapObserverService } from '@/swaps/chain-swap-observer.service';
import { ChainSwapsService } from '@/swaps/chain-swaps.service';
import type { CreateSwapDto } from '@/swaps/dto/create-swap.dto';
import type { MonadSwapVenue } from '@/swaps/venues/monad-swap.venue';
import type { SolanaSwapVenue } from '@/swaps/venues/solana-swap.venue';
import type { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';

const SOURCE = '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const consumer: GatewayConsumer = {
  username: 'cosmos_u1',
  credentialId: 'cred_1',
  environment: 'prod',
  role: 'user',
  permissions: ['swaps:write'],
  organizationId: 'org_1',
  plan: 'pro',
  planSwapFeeBps: 50,
};

const DTO = {
  chain: 'solana',
  sourceAssetCode: 'SOL',
  destAssetCode: USDC,
  amount: '0.1',
  source: SOURCE,
} as CreateSwapDto;

/** An in-memory `chainSwap` table. */
function fakePrisma() {
  const rows: any[] = [];
  const matches = (row: any, where: any) =>
    Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
      if (k === 'consumer')
        return row.consumer.apisixUsername === v.apisixUsername;
      if (k === 'consumerId_idempotencyKey') {
        return (
          row.consumerId === v.consumerId &&
          row.idempotencyKey === v.idempotencyKey
        );
      }
      return row[k] === v;
    });
  const chainSwap = {
    create: jest.fn(async ({ data }: any) => {
      const row = {
        id: `cs_${rows.length + 1}`,
        txHash: null,
        approval: null,
        lastCheckedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        consumer: { apisixUsername: 'cosmos_u1' },
        ...data,
      };
      rows.push(row);
      return row;
    }),
    findUnique: jest.fn(
      async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    ),
    findFirst: jest.fn(
      async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    ),
    findUniqueOrThrow: jest.fn(async ({ where }: any) =>
      rows.find((r) => matches(r, where)),
    ),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => matches(r, where));
      Object.assign(row, data);
      return row;
    }),
  };
  return { rows, prisma: { chainSwap } as unknown as PrismaService };
}

function setup(feeWallet = 'FeeWa11et1111111111111111111111111111111111') {
  const cfg: Record<string, unknown> = {
    nodeEnv: 'test',
    stellar: {
      network: 'testnet',
      swap: { slippageBps: 50, maxSlippageBps: 500, feeWallet: '', feeBps: 50 },
    },
    solana: { swapFeeWallet: feeWallet, timeoutMs: 1000 },
    monad: { swapFeeWallet: '', timeoutMs: 1000 },
    observer: { enabled: true, intervalMs: 15000 },
    apisix: { swapFeeBpsHeader: 'x-plan-swap-fee-bps' },
  };
  const config = { get: (k: string) => cfg[k] } as unknown as ConfigService<
    any,
    true
  >;
  const { rows, prisma } = fakePrisma();
  const webhooks = { emit: jest.fn().mockResolvedValue(true) };
  const solana = {
    resolveAsset: jest.fn(async (a: string) =>
      a === 'SOL'
        ? { asset: 'native', decimals: 9 }
        : { asset: a, decimals: 6 },
    ),
    quote: jest.fn().mockResolvedValue({
      destEstimated: 11878546n,
      destMin: 11819154n,
      feeAmount: 59691n,
      path: [],
      raw: { q: 1 },
    }),
    build: jest.fn().mockResolvedValue({
      destEstimated: 11878546n,
      destMin: 11819154n,
      feeAmount: 59691n,
      path: [],
      raw: { q: 1 },
      transaction: { encoding: 'base64', data: 'AAAA' },
      approval: null,
    }),
    verify: jest.fn().mockReturnValue('sig_1'),
    broadcast: jest.fn().mockResolvedValue(undefined),
    settlement: jest.fn(),
  };
  const service = new ChainSwapsService(
    config,
    prisma,
    webhooks as unknown as WebhookTerminalEmitter,
    {
      resolve: jest.fn().mockResolvedValue({ id: 'consumer_1' }),
    } as unknown as ConsumerResolverService,
    solana as unknown as SolanaSwapVenue,
    {} as unknown as MonadSwapVenue,
  );
  return { service, rows, webhooks, solana, prisma, config };
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('expected a rejection');
}

describe('ChainSwapsService', () => {
  it('quotes in the Stellar quote shape, commission from the output', async () => {
    const { service, solana } = setup();
    const quote = await service.quote(consumer, DTO);

    expect(solana.quote.mock.calls[0][0]).toMatchObject({
      source: SOURCE,
      amount: 100_000_000n,
      feeBps: 50,
      slippageBps: 50,
    });
    expect(quote).toMatchObject({
      network: 'public',
      chain: 'solana',
      provider: 'jupiter',
      source: { asset: 'native', amount: '0.1' },
      fee: { asset: USDC, amount: '0.059691', bps: 50 },
      destination: { estimated: '11.878546', minimum: '11.819154' },
    });
  });

  it('refuses a dev key before calling anyone: the aggregators are mainnet only', async () => {
    const { service, solana } = setup();
    const err = await rejection(
      service.quote({ ...consumer, environment: 'dev' }, DTO),
    );
    expect(err.code).toBe(ApiErrorCode.NetworkUnsupported);
    expect(solana.resolveAsset).not.toHaveBeenCalled();
  });

  it('refuses the Stellar-only fields rather than ignore them', async () => {
    const { service } = setup();
    for (const extra of [
      { memo: '1' },
      { destAssetIssuer: 'G…' },
      { destination: USDC },
    ]) {
      const err = await rejection(
        service.quote(consumer, { ...DTO, ...extra }),
      );
      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
    }
  });

  it('refuses a commission it has nowhere to pay', async () => {
    const { service } = setup('');
    const err = await rejection(service.quote(consumer, DTO));
    expect(err.code).toBe(ApiErrorCode.Misconfigured);
    expect(err.message).toContain('SOLANA_SWAP_FEE_WALLET');
  });

  it('creates a PENDING swap with the transaction to sign, and notifies', async () => {
    const { service, webhooks } = setup();
    const swap = await service.create(consumer, DTO);

    expect(swap).toMatchObject({
      chain: 'solana',
      provider: 'jupiter',
      status: 'PENDING',
      transaction: { encoding: 'base64', data: 'AAAA' },
      txHash: null,
    });
    expect(swap).not.toHaveProperty('quote');
    expect(swap).not.toHaveProperty('consumerId');
    expect(webhooks.emit).toHaveBeenCalledWith(
      'cosmos_u1',
      'SWAP_CREATED',
      expect.objectContaining({ id: swap.id }),
    );
  });

  it('replays an Idempotency-Key for the same request, refuses it for another', async () => {
    const { service, solana } = setup();
    const first = await service.create(consumer, DTO, 'k1');
    const again = await service.create(consumer, DTO, 'k1');
    expect(again.id).toBe(first.id);
    expect(solana.build).toHaveBeenCalledTimes(1);

    const err = await rejection(
      service.create(consumer, { ...DTO, amount: '0.2' }, 'k1'),
    );
    expect(err.code).toBe(ApiErrorCode.IdempotencyConflict);
  });

  describe('submit', () => {
    it('verifies before it discloses anything — even that the swap expired', async () => {
      const { service, rows, solana } = setup();
      const created = await service.create(consumer, DTO);
      rows[0].expiresAt = new Date(0);
      solana.verify.mockImplementation(() => {
        throw ApiError.badRequest(
          ApiErrorCode.ValidationFailed,
          'not the one built',
        );
      });

      const err = await rejection(service.submit(consumer, rows[0], 'forged'));
      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      expect(solana.broadcast).not.toHaveBeenCalled();
      expect(created.status).toBe('PENDING');
    });

    it('refuses an expired swap once the transaction checks out', async () => {
      const { service, rows, solana } = setup();
      await service.create(consumer, DTO);
      rows[0].expiresAt = new Date(0);
      const err = await rejection(service.submit(consumer, rows[0], 'signed'));
      expect(err.code).toBe(ApiErrorCode.InvalidStateTransition);
      expect(solana.broadcast).not.toHaveBeenCalled();
    });

    it('broadcasts, records the hash and moves to SUBMITTED once', async () => {
      const { service, rows, webhooks } = setup();
      await service.create(consumer, DTO);
      webhooks.emit.mockClear();

      const out = await service.submit(consumer, { ...rows[0] }, 'signed');
      await service.submit(consumer, { ...rows[0] }, 'signed');

      expect(out).toMatchObject({
        submitted: true,
        status: 'SUBMITTED',
        txHash: 'sig_1',
      });
      expect(rows[0].txHash).toBe('sig_1');
      expect(webhooks.emit).toHaveBeenCalledTimes(1);
      expect(webhooks.emit.mock.calls[0][1]).toBe('SWAP_SUBMITTED');
    });

    it('leaves the swap PENDING when the node refuses the broadcast', async () => {
      const { service, rows, solana } = setup();
      await service.create(consumer, DTO);
      solana.broadcast.mockRejectedValue(
        ApiError.badRequest(
          ApiErrorCode.TransactionRejected,
          'Blockhash not found',
        ),
      );
      const err = await rejection(service.submit(consumer, rows[0], 'signed'));
      expect(err.code).toBe(ApiErrorCode.TransactionRejected);
      expect(rows[0].status).toBe('PENDING');
    });
  });

  describe('the observer', () => {
    function observer(ctx: ReturnType<typeof setup>, rows: any[]) {
      const prisma = {
        chainSwap: { findMany: jest.fn().mockResolvedValue(rows) },
      };
      return new ChainSwapObserverService(
        ctx.config,
        prisma as unknown as PrismaService,
        ctx.service,
        {
          runExclusive: (_k: unknown, work: () => Promise<unknown>) => work(),
        } as unknown as AdvisoryLockService,
      );
    }

    it('settles a submitted swap on the chain verdict and notifies once', async () => {
      const ctx = setup();
      await ctx.service.create(consumer, DTO);
      Object.assign(ctx.rows[0], { status: 'SUBMITTED', txHash: 'sig_1' });
      ctx.solana.settlement.mockResolvedValue('SUCCEEDED');
      ctx.webhooks.emit.mockClear();

      const row = { ...ctx.rows[0] };
      await observer(ctx, [row]).tick();
      await observer(ctx, [row]).tick();

      expect(ctx.rows[0].status).toBe('SUCCEEDED');
      expect(ctx.webhooks.emit).toHaveBeenCalledTimes(1);
      expect(ctx.webhooks.emit.mock.calls[0][1]).toBe('SWAP_SUCCEEDED');
    });

    it('expires a swap never submitted, without a webhook', async () => {
      const ctx = setup();
      await ctx.service.create(consumer, DTO);
      ctx.rows[0].expiresAt = new Date(0);
      ctx.webhooks.emit.mockClear();

      await observer(ctx, [{ ...ctx.rows[0] }]).tick();

      expect(ctx.rows[0].status).toBe('EXPIRED');
      expect(ctx.webhooks.emit).not.toHaveBeenCalled();
    });

    it('expires a submitted swap unseen past its landing window, and keeps looking before that', async () => {
      const ctx = setup();
      await ctx.service.create(consumer, DTO);
      Object.assign(ctx.rows[0], { status: 'SUBMITTED', txHash: 'sig_1' });
      ctx.solana.settlement.mockResolvedValue(null);

      await observer(ctx, [{ ...ctx.rows[0] }]).tick();
      expect(ctx.rows[0].status).toBe('SUBMITTED');
      expect(ctx.rows[0].lastCheckedAt).toBeInstanceOf(Date);

      ctx.rows[0].expiresAt = new Date(0);
      await observer(ctx, [{ ...ctx.rows[0] }]).tick();
      expect(ctx.rows[0].status).toBe('EXPIRED');
    });
  });
});
