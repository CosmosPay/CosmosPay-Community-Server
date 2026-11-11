import { ConfigService } from '@nestjs/config';
import { PublicRecordTokens } from '@/common/public-record-token';
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

/** Record tokens as the app wires them; no consumer here is the shared public key. */
const recordTokens = new PublicRecordTokens({
  get: () => ({
    publicConsumer: 'cosmos_public',
    gatewaySecret: 'spec-gateway-secret-spec-gateway-secret',
  }),
} as never);

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
      if (v && typeof v === 'object' && Array.isArray(v.in)) {
        return v.in.includes(row[k]);
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
    merchantFeeUnsupported: () => null,
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
  const monad = {
    merchantFeeUnsupported: () =>
      'no merchant fee router is configured (KURU_MERCHANT_FEE_ROUTER)',
    verify: jest.fn(),
    verifySent: jest.fn((_swap: unknown, hash: string) =>
      Promise.resolve(hash.toLowerCase()),
    ),
    broadcast: jest.fn(),
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
    monad as unknown as MonadSwapVenue,
    recordTokens,
  );
  return { service, rows, webhooks, solana, monad, prisma, config };
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

  it('charges the fee wallet nothing when it swaps its own funds', async () => {
    const { service, solana } = setup(SOURCE);
    const quote = await service.quote(consumer, DTO);

    expect(solana.quote.mock.calls[0][0]).toMatchObject({ feeBps: 0 });
    expect(quote).toMatchObject({ fee: { bps: 0 } });
  });

  it('refuses a commission it has nowhere to pay', async () => {
    const { service } = setup('');
    const err = await rejection(service.quote(consumer, DTO));
    expect(err.code).toBe(ApiErrorCode.Misconfigured);
    expect(err.operatorDetail).toContain('SOLANA_SWAP_FEE_WALLET');
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

  describe('submit with txHash (a Monad wallet that sent the transaction itself)', () => {
    const HASH = `0x${'ab'.repeat(32)}`;
    const OTHER_HASH = `0x${'cd'.repeat(32)}`;

    /** A Monad swap as create stores it. */
    function monadSwap(rows: any[], over: Record<string, unknown> = {}): any {
      const row = {
        id: `cs_${rows.length + 1}`,
        consumerId: 'consumer_1',
        consumer: { apisixUsername: 'cosmos_u1' },
        chain: 'monad',
        network: 'public',
        provider: 'kuru',
        status: 'PENDING',
        source: '0x62eE1b8d1EFdF8f73C78db87B888406B194e266A',
        transaction: {
          to: '0xb3e6778480b2E488385E8205eA05E20060B813cb',
          data: '0xce1e7030',
          value: '0',
          chainId: 143,
        },
        approval: null,
        txHash: null,
        expiresAt: new Date(Date.now() + 60_000),
        lastCheckedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...over,
      };
      rows.push(row);
      return row;
    }

    it('records the hash once the chain shows the call built, SUBMITTED once, broadcasting nothing', async () => {
      const { service, rows, monad, webhooks } = setup();
      const swap = monadSwap(rows);

      const out = await service.submit(consumer, { ...swap }, undefined, HASH);

      expect(monad.verifySent).toHaveBeenCalledWith(
        expect.objectContaining({ id: swap.id }),
        HASH,
      );
      expect(monad.broadcast).not.toHaveBeenCalled();
      expect(out).toMatchObject({
        submitted: true,
        status: 'SUBMITTED',
        txHash: HASH,
        swap: { id: swap.id, status: 'SUBMITTED', txHash: HASH },
      });
      expect(rows[0]).toMatchObject({ status: 'SUBMITTED', txHash: HASH });
      expect(webhooks.emit).toHaveBeenCalledTimes(1);
      expect(webhooks.emit.mock.calls[0][1]).toBe('SWAP_SUBMITTED');
    });

    it('answers the same hash again with the swap as it is, still checking the chain first', async () => {
      const { service, rows, monad, webhooks } = setup();
      const swap = monadSwap(rows, { status: 'SUCCEEDED', txHash: HASH });

      const out = await service.submit(consumer, { ...swap }, undefined, HASH);

      expect(monad.verifySent).toHaveBeenCalledTimes(1);
      expect(out).toMatchObject({
        submitted: true,
        status: 'SUCCEEDED',
        txHash: HASH,
      });
      expect(rows[0].status).toBe('SUCCEEDED');
      expect(webhooks.emit).not.toHaveBeenCalled();
    });

    it('checks the transaction before it discloses anything about the swap', async () => {
      const { service, rows, monad } = setup();
      const swap = monadSwap(rows, {
        status: 'SUBMITTED',
        txHash: OTHER_HASH,
      });
      monad.verifySent.mockRejectedValueOnce(
        ApiError.badRequest(
          ApiErrorCode.ValidationFailed,
          'txHash names a transaction whose `input` is not the calldata built for this swap',
        ),
      );
      const err = await rejection(
        service.submit(consumer, { ...swap }, undefined, HASH),
      );
      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      expect(err.message).not.toContain(OTHER_HASH);
    });

    it('records nothing while the chain does not have the transaction yet', async () => {
      const { service, rows, monad, webhooks } = setup();
      const swap = monadSwap(rows);
      monad.verifySent.mockRejectedValueOnce(
        ApiError.badRequest(
          ApiErrorCode.TransactionNotFound,
          'Transaction is not on Monad yet. Retry in a few seconds.',
        ),
      );
      const err = await rejection(
        service.submit(consumer, { ...swap }, undefined, HASH),
      );
      expect(err.code).toBe(ApiErrorCode.TransactionNotFound);
      expect(rows[0]).toMatchObject({ status: 'PENDING', txHash: null });
      expect(webhooks.emit).not.toHaveBeenCalled();
    });

    it('refuses a hash recorded on another swap, read before the write and caught during it', async () => {
      const { service, rows, prisma } = setup();
      const swap = monadSwap(rows);
      monadSwap(rows, { status: 'SUBMITTED', txHash: HASH });

      let err = await rejection(
        service.submit(consumer, { ...swap }, undefined, HASH),
      );
      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      expect(err.message).toContain('another swap');
      expect(rows[0]).toMatchObject({ status: 'PENDING', txHash: null });

      // Another swap recorded it between the read and the write.
      rows[1].txHash = OTHER_HASH;
      (prisma.chainSwap.updateMany as jest.Mock).mockRejectedValueOnce({
        code: 'P2002',
      });
      err = await rejection(
        service.submit(consumer, { ...swap }, undefined, HASH),
      );
      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      expect(err.message).toContain('another swap');
      expect(rows[0]).toMatchObject({ status: 'PENDING', txHash: null });
    });

    it('refuses another hash on a swap already submitted with one', async () => {
      const { service, rows } = setup();
      const swap = monadSwap(rows, {
        status: 'SUBMITTED',
        txHash: OTHER_HASH,
      });
      const err = await rejection(
        service.submit(consumer, { ...swap }, undefined, HASH),
      );
      expect(err.code).toBe(ApiErrorCode.InvalidStateTransition);
      expect(rows[0].txHash).toBe(OTHER_HASH);
    });

    it('refuses a hash a concurrent submit lost to another one', async () => {
      const { service, rows } = setup();
      const swap = monadSwap(rows);
      // Read PENDING; another request records its hash before this write.
      const stale = { ...swap };
      rows[0].status = 'SUBMITTED';
      rows[0].txHash = OTHER_HASH;
      const err = await rejection(
        service.submit(consumer, stale, undefined, HASH),
      );
      expect(err.code).toBe(ApiErrorCode.InvalidStateTransition);
      expect(rows[0].txHash).toBe(OTHER_HASH);
    });

    it('takes a hash past the validity window, and on a swap expired before any hash: the transaction is already out', async () => {
      const { service, rows } = setup();
      const late = monadSwap(rows, { expiresAt: new Date(0) });
      const expired = monadSwap(rows, {
        status: 'EXPIRED',
        expiresAt: new Date(0),
      });

      await service.submit(consumer, { ...late }, undefined, HASH);
      await service.submit(consumer, { ...expired }, undefined, OTHER_HASH);

      expect(rows[0]).toMatchObject({ status: 'SUBMITTED', txHash: HASH });
      expect(rows[1]).toMatchObject({
        status: 'SUBMITTED',
        txHash: OTHER_HASH,
      });
    });

    it('asks a Solana swap for signedTransaction, and a Monad one for exactly one of the two', async () => {
      const { service, rows, solana, monad } = setup();
      await service.create(consumer, DTO);
      const solanaSwap = rows[0];
      const swap = monadSwap(rows);

      let err = await rejection(
        service.submit(consumer, solanaSwap, undefined, HASH),
      );
      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      expect(err.message).toContain('Solana swap takes signedTransaction');
      expect(solana.broadcast).not.toHaveBeenCalled();

      err = await rejection(service.submit(consumer, swap, '0x02f8', HASH));
      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      expect(err.message).toBe('Send signedTransaction or txHash, not both');

      err = await rejection(service.submit(consumer, swap, undefined));
      expect(err.message).toBe(
        'signedTransaction or txHash is required for a Monad swap',
      );
      err = await rejection(service.submit(consumer, solanaSwap, undefined));
      expect(err.message).toBe(
        'signedTransaction is required for a Solana swap',
      );
      expect(monad.verifySent).not.toHaveBeenCalled();
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

describe('ChainSwapsService merchant fee', () => {
  const FEE_WALLET = '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S';

  it('routes the amount less a fee the recipient pays, and hands the venue the fee', async () => {
    const { service, solana, rows } = setup();
    // 2% of 0.1 SOL: 0.002 SOL to the fee wallet, 0.098 routed.
    await service.create(consumer, {
      ...DTO,
      merchantFee: { bps: 200, wallet: FEE_WALLET },
    });

    const request = solana.build.mock.calls[0][0];
    expect(request.amount).toBe(98_000_000n);
    expect(request.merchantFee).toEqual({
      wallet: FEE_WALLET,
      amount: 2_000_000n,
    });
    expect(rows[0].sendAmount).toBe('0.1');
    expect(rows[0].merchantFee).toEqual({
      bps: 200,
      fixed: '0',
      amount: '0.002',
      asset: 'native',
      wallet: FEE_WALLET,
      paidBy: 'recipient',
    });
  });

  it('quotes the fee beside the routed amount', async () => {
    const { service } = setup();
    const quote = await service.quote(consumer, {
      ...DTO,
      merchantFee: { bps: 200, wallet: FEE_WALLET, paidBy: 'payer' },
    });
    // On top: the whole amount is routed.
    expect(quote.swap.amount).toBe('0.1');
    expect(quote.merchantFee).toMatchObject({
      amount: '0.002',
      paidBy: 'payer',
    });
  });

  it('refuses a replay with another fee, and a fee on Monad', async () => {
    const { service } = setup();
    await service.create(
      consumer,
      { ...DTO, merchantFee: { bps: 200, wallet: FEE_WALLET } },
      'k-fee',
    );
    const other = await rejection(
      service.create(
        consumer,
        { ...DTO, merchantFee: { bps: 300, wallet: FEE_WALLET } },
        'k-fee',
      ),
    );
    expect(other.code).toBe(ApiErrorCode.IdempotencyConflict);

    const monad = await rejection(
      service.quote(consumer, {
        ...DTO,
        chain: 'monad',
        merchantFee: {
          bps: 200,
          wallet: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
        },
      }),
    );
    expect(monad.code).toBe(ApiErrorCode.MerchantFeeUnsupported);
  });
});
