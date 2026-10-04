import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { Sep7LinkBuilder } from '@/payment-intents/sep7-link-builder.service';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';

const SOL_DEST = 'mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN';
const EVM_DEST = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const consumer = { username: 'cosmos_u1', environment: 'dev' } as never;

const LINK = {
  destination: SOL_DEST,
  asset: 'native',
  assetIssuer: null,
  assetDecimals: null,
  uri: `solana:${SOL_DEST}?amount=1&reference=REF`,
  chainReference: 'REF',
  chainCursor: null,
  networkFee: null,
  deposit: null,
};

function build(stored: unknown[] = [null]) {
  const findUnique = jest.fn();
  for (const row of stored) findUnique.mockResolvedValueOnce(row);
  const create = jest.fn(({ data }) =>
    Promise.resolve({
      id: 'pi_new',
      createdAt: new Date(),
      updatedAt: new Date(),
      txHash: null,
      reference: null,
      ...data,
    }),
  );
  const prisma: any = {
    consumer: { upsert: jest.fn().mockResolvedValue({ id: 'c1' }) },
    paymentIntent: {
      findUnique,
      create,
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    webhookEndpoint: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const config = {
    get: () => ({ network: 'testnet', ttlSeconds: 3600, horizon: {} }),
  } as never;
  const chainLinks = {
    normalize: jest.fn((chain: string, dto: { destination: string }) => ({
      destination: chain === 'monad' ? EVM_DEST : dto.destination,
      asset: 'native',
      assetIssuer: null,
    })),
    build: jest.fn().mockResolvedValue(LINK),
  };
  const verifier = { verifyByHash: jest.fn() };
  const service = new PaymentIntentsService(
    config,
    prisma,
    new WebhookTerminalEmitter(prisma, { emit: jest.fn() } as never),
    { for: () => verifier } as never,
    new Sep7LinkBuilder(config, {} as never, {} as never),
    new ConsumerResolverService(prisma),
    { ensureForPayer: jest.fn() } as never,
    chainLinks as never,
  );
  return { service, prisma, chainLinks, verifier };
}

describe('PaymentIntentsService on Solana and Monad', () => {
  it('stores a Solana PAY intent with its chain, reference and link', async () => {
    const { service, prisma, chainLinks } = build();
    const view = await service.createPay(consumer, {
      chain: 'solana',
      destination: SOL_DEST,
      amount: '1',
      memo: '42',
    });

    expect(chainLinks.build).toHaveBeenCalledWith(
      'solana',
      expect.objectContaining({ network: 'testnet', memo: '42' }),
    );
    expect(prisma.paymentIntent.create.mock.calls[0][0].data).toMatchObject({
      kind: 'PAY',
      chain: 'solana',
      network: 'testnet',
      destination: SOL_DEST,
      chainReference: 'REF',
      uri: LINK.uri,
      xdr: null,
    });
    expect(view).toMatchObject({ chain: 'solana', chainReference: 'REF' });
    expect(view.qr).toMatch(/^data:image\/png;base64,/);
  });

  it('writes a Monad deposit address in the same insert as its intent', async () => {
    const { service, prisma, chainLinks } = build();
    const deposit = {
      address: '0xC830d264C14ebDB31cdEa0Fb6f83C5b0D8EEc52F',
      salt: `0x${'11'.repeat(32)}`,
      destination: EVM_DEST,
      token: null,
      relayer: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      fee: 57_375_000_000_000_000n,
    };
    chainLinks.build.mockResolvedValueOnce({
      ...LINK,
      destination: EVM_DEST,
      uri: `ethereum:${deposit.address}@10143?value=1000000000000000000`,
      chainReference: deposit.address,
      networkFee: '0.057375',
      deposit,
    });

    const view = await service.createPay(consumer, {
      chain: 'monad',
      destination: EVM_DEST,
      amount: '1',
      memo: '42',
    });

    expect(prisma.paymentIntent.create).toHaveBeenCalledTimes(1);
    const data = prisma.paymentIntent.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      chain: 'monad',
      chainReference: deposit.address,
      networkFee: '0.057375',
      evmDeposit: {
        create: {
          chain: 'monad',
          network: 'testnet',
          address: deposit.address,
          salt: deposit.salt,
          destination: EVM_DEST,
          token: null,
          relayer: deposit.relayer,
          fee: '57375000000000000',
        },
      },
    });
    expect(view).toMatchObject({ networkFee: '0.057375' });
  });

  it('refuses a SEP-7 callback off Stellar', async () => {
    const { service } = build();
    const err = await service
      .createPay(consumer, {
        chain: 'solana',
        destination: SOL_DEST,
        callback: 'url:https://x.example',
      })
      .catch((e: unknown) => e as ApiError);
    expect((err as ApiError).code).toBe(ApiErrorCode.ValidationFailed);
  });

  it('holds a replay to the same chain: memo 42 on Stellar is not memo 42 on Solana', async () => {
    const stellarRow = {
      id: 'pi_old',
      kind: 'PAY',
      chain: 'stellar',
      network: 'testnet',
      source: null,
      destination: SOL_DEST,
      amount: '1',
      asset: 'native',
      assetIssuer: null,
      msg: null,
      callback: null,
      uri: 'web+stellar:pay?x',
    };
    const { service, chainLinks } = build([stellarRow]);
    const err = await service
      .createPay(consumer, {
        chain: 'solana',
        destination: SOL_DEST,
        amount: '1',
        memo: '42',
      })
      .catch((e: unknown) => e as ApiError);
    expect((err as ApiError).code).toBe(ApiErrorCode.IdempotencyConflict);
    expect(chainLinks.build).not.toHaveBeenCalled();
  });

  it('compares a retried Monad destination in its stored spelling', async () => {
    const monadRow = {
      id: 'pi_old',
      consumerId: 'c1',
      kind: 'PAY',
      chain: 'monad',
      network: 'testnet',
      source: null,
      destination: EVM_DEST,
      amount: '1',
      asset: 'native',
      assetIssuer: null,
      msg: null,
      callback: null,
      memo: '42',
      uri: `ethereum:${EVM_DEST}@10143?value=1`,
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { service, chainLinks } = build([monadRow]);
    const view = await service.createPay(consumer, {
      chain: 'monad',
      destination: EVM_DEST.toLowerCase(),
      amount: '1.0',
      memo: '42',
    });
    expect(view.id).toBe('pi_old');
    expect(chainLinks.build).not.toHaveBeenCalled();
  });

  it('refuses a transaction id of another chain before asking any chain', async () => {
    const { service, prisma, verifier } = build();
    prisma.paymentIntent.findFirst.mockResolvedValue({
      id: 'pi_1',
      chain: 'monad',
      status: 'PENDING',
    });
    const err = await service
      .validate(consumer, 'pi_1', 'ab'.repeat(32))
      .catch((e: unknown) => e as ApiError);
    expect((err as ApiError).code).toBe(ApiErrorCode.ValidationFailed);
    expect((err as ApiError).message).toMatch(/Monad transaction hash/);
    expect(verifier.verifyByHash).not.toHaveBeenCalled();
  });

  it('advances the observer’s cursor only while the intent is still PENDING', async () => {
    const { service, prisma } = build();
    await service.advanceCursor('pi_1', '600');
    expect(prisma.paymentIntent.updateMany).toHaveBeenCalledWith({
      where: { id: 'pi_1', status: 'PENDING' },
      data: { chainCursor: '600' },
    });
  });
});
