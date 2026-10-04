import { ConfigService } from '@nestjs/config';
import { Keypair } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import type { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { CrossChainSwapsService } from '@/cross-chain-swaps/cross-chain-swaps.service';
import type { NearIntentsClient } from '@/near-intents/near-intents.client';
import type {
  NearIntentsQuoteRequest,
  NearIntentsToken,
} from '@/near-intents/near-intents.types';
import type { PrismaService } from '@/prisma/prisma.service';
import type { StellarAccountLoader } from '@/stellar/account-loader.service';
import type { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';

jest.mock('qrcode', () => ({
  __esModule: true,
  default: {
    toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,qq'),
  },
}));

const SOLANA_RECIPIENT = '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK';
const STELLAR_PAYER = Keypair.random().publicKey();
const STELLAR_DEPOSIT = Keypair.random().publicKey();
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

const TOKENS: NearIntentsToken[] = [
  { assetId: 'xlm-id', decimals: 7, blockchain: 'stellar', symbol: 'XLM' },
  {
    assetId: 'susdc-id',
    decimals: 7,
    blockchain: 'stellar',
    symbol: 'USDC',
    contractAddress: USDC_ISSUER,
  },
  { assetId: 'sol-id', decimals: 9, blockchain: 'sol', symbol: 'SOL' },
  {
    assetId: 'usdc-sol-id',
    decimals: 6,
    blockchain: 'sol',
    symbol: 'USDC',
    contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
];

const prodConsumer: GatewayConsumer = {
  username: 'cosmos_u1',
  credentialId: 'cred_1',
  environment: 'prod',
  role: 'user',
  permissions: ['swaps:write'],
  organizationId: 'org_1',
  plan: 'pro',
  planSwapFeeBps: 50,
};

const BASE_DTO = {
  originChain: 'stellar' as const,
  originAsset: 'XLM',
  destinationChain: 'solana' as const,
  destinationAsset: 'USDC',
  amount: '100',
  recipient: SOLANA_RECIPIENT,
  refundTo: STELLAR_PAYER,
};

function quoteResponse(request: NearIntentsQuoteRequest) {
  return {
    correlationId: 'corr-1',
    timestamp: '2026-10-02T12:00:00Z',
    signature: 'ed25519:sig',
    quoteRequest: request,
    quote: {
      amountIn: request.amount,
      amountInFormatted: '100',
      amountInUsd: '22.57',
      minAmountIn: request.amount,
      amountOut: '22189466',
      amountOutFormatted: '22.189466',
      amountOutUsd: '22.18',
      minAmountOut: '21967571',
      timeEstimate: 22,
      ...(request.dry
        ? {}
        : {
            depositAddress: STELLAR_DEPOSIT,
            depositMemo: '188866795',
            deadline: '2026-10-02T12:30:00.000Z',
          }),
    },
  };
}

/** An in-memory `crossChainSwap` table, enough for the service's queries. */
function fakePrisma() {
  const rows: any[] = [];
  const matches = (row: any, where: any) =>
    Object.entries(where ?? {}).every(([key, value]) => {
      if (key === 'consumer') {
        return (value as any).apisixUsername === row.consumer.apisixUsername;
      }
      if (key === 'consumerId_idempotencyKey') {
        const v = value as any;
        return (
          row.consumerId === v.consumerId &&
          row.idempotencyKey === v.idempotencyKey
        );
      }
      return row[key] === value;
    });
  const table = {
    create: jest.fn(async ({ data }: any) => {
      if (
        data.idempotencyKey &&
        rows.some(
          (r) =>
            r.consumerId === data.consumerId &&
            r.idempotencyKey === data.idempotencyKey,
        )
      ) {
        throw Object.assign(new Error('unique'), {
          code: 'P2002',
          meta: { target: ['consumerId', 'idempotencyKey'] },
        });
      }
      const row = {
        id: `ccs_${rows.length + 1}`,
        depositTxHash: null,
        amountOut: null,
        refundedAmount: null,
        originTxHashes: null,
        destinationTxHashes: null,
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
    findUniqueOrThrow: jest.fn(async ({ where }: any) =>
      rows.find((r) => matches(r, where)),
    ),
    findFirst: jest.fn(
      async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    ),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => matches(r, where));
      Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
  };
  return {
    rows,
    prisma: { crossChainSwap: table } as unknown as PrismaService,
  };
}

function setup(
  opts: { feeRecipient?: string; network?: 'public' | 'testnet' } = {},
) {
  const cfg: Record<string, unknown> = {
    nodeEnv: 'test',
    nearIntents: {
      baseUrl: 'https://1click.example',
      apiKey: '',
      feeRecipient: opts.feeRecipient ?? 'cosmospay.near',
      timeoutMs: 5000,
      slippageBps: 100,
      maxSlippageBps: 500,
      deadlineSeconds: 1800,
    },
    stellar: {
      network: opts.network ?? 'testnet',
      swap: { feeWallet: '', feeBps: 50 },
    },
    apisix: { swapFeeBpsHeader: 'x-plan-swap-fee-bps' },
  };
  const config = {
    get: (key: string) => cfg[key],
  } as unknown as ConfigService<any, true>;
  const { rows, prisma } = fakePrisma();
  const webhooks = { emit: jest.fn().mockResolvedValue(true) };
  const consumers = {
    resolve: jest.fn().mockResolvedValue({ id: 'consumer_1' }),
  };
  const nearIntents = {
    tokens: jest.fn().mockResolvedValue(TOKENS),
    quote: jest.fn(async (request: NearIntentsQuoteRequest) =>
      quoteResponse(request),
    ),
    status: jest.fn(),
    submitDeposit: jest.fn(),
  };
  const accounts = {
    load: jest.fn().mockResolvedValue({ balances: [] }),
    assertTrustline: jest.fn(),
  };
  const service = new CrossChainSwapsService(
    config,
    prisma,
    webhooks as unknown as WebhookTerminalEmitter,
    consumers as unknown as ConsumerResolverService,
    nearIntents as unknown as NearIntentsClient,
    accounts as unknown as StellarAccountLoader,
  );
  return { service, rows, webhooks, nearIntents, accounts };
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('expected a rejection');
}

describe('CrossChainSwapsService', () => {
  describe('quote', () => {
    it('asks 1Click for a dry EXACT_INPUT quote with the plan commission as an app fee', async () => {
      const { service, nearIntents } = setup();

      const quote = await service.quote(prodConsumer, BASE_DTO);

      const request = nearIntents.quote.mock.calls[0][0];
      expect(request).toMatchObject({
        dry: true,
        swapType: 'EXACT_INPUT',
        depositMode: 'MEMO',
        originAsset: 'xlm-id',
        destinationAsset: 'usdc-sol-id',
        amount: '1000000000',
        recipient: SOLANA_RECIPIENT,
        refundTo: STELLAR_PAYER,
        slippageTolerance: 100,
        referral: 'cosmospay',
        appFees: [{ recipient: 'cosmospay.near', fee: 50 }],
      });
      expect(quote.fee).toEqual({ bps: 50, amount: '0.5', asset: 'XLM' });
      expect(quote.destination).toMatchObject({
        asset: 'USDC',
        amount: '22.189466',
        minimum: '21.967571',
      });
    });

    it('takes the rate from the plan, never from the request', async () => {
      const { service, nearIntents } = setup();
      await service.quote({ ...prodConsumer, planSwapFeeBps: 0 }, {
        ...BASE_DTO,
        feeBps: 1,
      } as never);
      expect(nearIntents.quote.mock.calls[0][0]).not.toHaveProperty('appFees');
    });

    it('refuses to quote a commission it has nowhere to pay', async () => {
      const { service, nearIntents } = setup({ feeRecipient: '' });
      const err = await rejection(service.quote(prodConsumer, BASE_DTO));
      expect(err.code).toBe(ApiErrorCode.Misconfigured);
      expect(nearIntents.quote).not.toHaveBeenCalled();
    });

    it('sends Stellar → Stellar to the native DEX', async () => {
      const { service } = setup();
      const err = await rejection(
        service.quote(prodConsumer, {
          ...BASE_DTO,
          destinationChain: 'stellar',
          destinationAsset: 'USDC',
          recipient: STELLAR_PAYER,
        }),
      );
      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      expect(err.message).toContain('/v1/swaps');
    });

    it('sends Solana → Solana to Jupiter on /v1/swaps, without asking NEAR Intents', async () => {
      const { service, nearIntents } = setup();
      const err = await rejection(
        service.quote(prodConsumer, {
          ...BASE_DTO,
          originChain: 'solana',
          originAsset: 'SOL',
          refundTo: SOLANA_RECIPIENT,
        }),
      );
      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      expect(err.message).toContain('POST /v1/swaps with chain "solana"');
      expect(err.message).toContain('Jupiter');
      expect(nearIntents.quote).not.toHaveBeenCalled();
    });

    it('refuses more decimals than the origin asset has', async () => {
      const { service } = setup();
      const err = await rejection(
        service.quote(prodConsumer, { ...BASE_DTO, amount: '1.12345678' }),
      );
      expect(err.code).toBe(ApiErrorCode.InvalidAmount);
    });

    it('quotes for a dev key too: the price is mainnet’s either way', async () => {
      const { service } = setup();
      await expect(
        service.quote({ ...prodConsumer, environment: 'dev' }, BASE_DTO),
      ).resolves.toMatchObject({ network: 'public' });
    });
  });

  describe('create', () => {
    it('persists the live quote with a MEMO_TEXT SEP-7 deposit link and notifies', async () => {
      const { service, rows, webhooks, nearIntents } = setup();

      const swap = await service.create(prodConsumer, BASE_DTO);

      expect(nearIntents.quote.mock.calls[0][0].dry).toBe(false);
      expect(swap).toMatchObject({
        status: 'AWAITING_DEPOSIT',
        depositAddress: STELLAR_DEPOSIT,
        depositMemo: '188866795',
        amountIn: '100',
        feeAmount: '0.5',
        qr: 'data:image/png;base64,qq',
      });
      expect(swap.depositUri).toContain('memo_type=MEMO_TEXT');
      expect(swap).not.toHaveProperty('quote');
      expect(swap).not.toHaveProperty('consumerId');
      expect(rows[0].quote).toMatchObject({ signature: 'ed25519:sig' });
      expect(webhooks.emit).toHaveBeenCalledWith(
        'cosmos_u1',
        'CROSS_CHAIN_SWAP_CREATED',
        expect.not.objectContaining({ quote: expect.anything() }),
      );
    });

    it('refuses a dev key: a deposit address would take real money', async () => {
      const { service, nearIntents } = setup();
      const err = await rejection(
        service.create({ ...prodConsumer, environment: 'dev' }, BASE_DTO),
      );
      expect(err.code).toBe(ApiErrorCode.NetworkUnsupported);
      expect(nearIntents.quote).not.toHaveBeenCalled();
    });

    it('checks a Stellar recipient trusts the asset it is about to receive', async () => {
      const { service, accounts } = setup();
      accounts.assertTrustline.mockImplementation(() => {
        throw ApiError.badRequest(ApiErrorCode.TrustlineMissing, 'no trust');
      });
      const err = await rejection(
        service.create(prodConsumer, {
          originChain: 'solana',
          originAsset: 'SOL',
          destinationChain: 'stellar',
          destinationAsset: 'USDC',
          amount: '1',
          recipient: STELLAR_PAYER,
          refundTo: SOLANA_RECIPIENT,
        }),
      );
      expect(err.code).toBe(ApiErrorCode.TrustlineMissing);
      expect(accounts.load).toHaveBeenCalledWith('public', STELLAR_PAYER);
    });

    it('replays the same request under the same key without a second deposit address', async () => {
      const { service, nearIntents } = setup();
      const first = await service.create(prodConsumer, BASE_DTO, 'key-1');
      const second = await service.create(prodConsumer, BASE_DTO, 'key-1');

      expect(second.id).toBe(first.id);
      expect(nearIntents.quote).toHaveBeenCalledTimes(1);
    });

    it('refuses the same key for a different request, describing nothing of the first', async () => {
      const { service } = setup();
      await service.create(prodConsumer, BASE_DTO, 'key-1');
      const err = await rejection(
        service.create(
          prodConsumer,
          { ...BASE_DTO, refundTo: Keypair.random().publicKey() },
          'key-1',
        ),
      );
      expect(err.code).toBe(ApiErrorCode.IdempotencyConflict);
      expect(err.message).not.toContain(STELLAR_DEPOSIT);
    });
  });

  describe('applyProviderStatus', () => {
    async function created() {
      const ctx = setup();
      const view = await ctx.service.create(prodConsumer, BASE_DTO);
      ctx.webhooks.emit.mockClear();
      return { ...ctx, row: ctx.rows.find((r) => r.id === view.id) };
    }

    it('moves the row and emits the outcome’s webhook, recording settlement', async () => {
      const { service, row, webhooks } = await created();

      const next = await service.applyProviderStatus(
        { ...row },
        {
          correlationId: 'c',
          status: 'SUCCESS',
          updatedAt: '',
          swapDetails: {
            amountOut: '22100000',
            amountOutFormatted: '22.1',
            originChainTxHashes: [{ hash: 'aa', explorerUrl: 'x' }],
            destinationChainTxHashes: [{ hash: 'bb', explorerUrl: 'y' }],
          },
        },
        'cosmos_u1',
      );

      expect(next.status).toBe('SUCCEEDED');
      expect(next.amountOut).toBe('22.1');
      expect(webhooks.emit).toHaveBeenCalledWith(
        'cosmos_u1',
        'CROSS_CHAIN_SWAP_SUCCEEDED',
        expect.objectContaining({ id: row.id, status: 'SUCCEEDED' }),
      );
    });

    it('lets only one of two racing writers transition and notify', async () => {
      const { service, row, webhooks } = await created();
      const stale = { ...row };
      const answer = {
        correlationId: 'c',
        status: 'PROCESSING' as const,
        updatedAt: '',
      };

      await service.applyProviderStatus(stale, answer, 'cosmos_u1');
      await service.applyProviderStatus(stale, answer, 'cosmos_u1');

      expect(webhooks.emit).toHaveBeenCalledTimes(1);
    });

    it('never moves an in-flight row back when 1Click does not know the address', async () => {
      const { service, row, webhooks } = await created();
      row.status = 'PROCESSING';

      const next = await service.applyProviderStatus(
        { ...row },
        null,
        'cosmos_u1',
      );

      expect(next.status).toBe('PROCESSING');
      expect(webhooks.emit).not.toHaveBeenCalled();
    });
  });

  describe('submitDeposit', () => {
    it('refuses a hash that is not a transaction id of the origin chain', async () => {
      const { service, nearIntents } = setup();
      const swap = await service.create(prodConsumer, BASE_DTO);
      const err = await rejection(
        service.submitDeposit(prodConsumer, swap.id, '0xnothex'),
      );
      expect(err.code).toBe(ApiErrorCode.ValidationFailed);
      expect(nearIntents.submitDeposit).not.toHaveBeenCalled();
    });

    it('passes the hash and memo to 1Click and records its answer', async () => {
      const { service, nearIntents } = setup();
      const swap = await service.create(prodConsumer, BASE_DTO);
      nearIntents.submitDeposit.mockResolvedValue({
        correlationId: 'c',
        status: 'KNOWN_DEPOSIT_TX',
        updatedAt: '',
      });

      const hash = 'AB'.repeat(32);
      const view = await service.submitDeposit(prodConsumer, swap.id, hash);

      expect(nearIntents.submitDeposit).toHaveBeenCalledWith({
        txHash: hash.toLowerCase(),
        depositAddress: STELLAR_DEPOSIT,
        memo: '188866795',
      });
      expect(view.status).toBe('DEPOSIT_DETECTED');
      expect(view.depositTxHash).toBe(hash.toLowerCase());
    });

    it('answers 404 for another consumer’s swap', async () => {
      const { service } = setup();
      const swap = await service.create(prodConsumer, BASE_DTO);
      const err = await rejection(
        service.submitDeposit(
          { ...prodConsumer, username: 'cosmos_other' },
          swap.id,
          'ab'.repeat(32),
        ),
      );
      expect(err.getStatus()).toBe(404);
    });
  });
});
