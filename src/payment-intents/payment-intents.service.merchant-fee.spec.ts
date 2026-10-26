import {
  Account,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { Sep7LinkBuilder } from '@/payment-intents/sep7-link-builder.service';

/**
 * A merchant fee on a Stellar payment intent: a `tx` intent carries both
 * payments in its envelope; a `pay` link, which SEP-7 lets pay one account
 * only, opens the hosted checkout, where the payer's envelope is built.
 */
describe('PaymentIntentsService merchant fee', () => {
  const consumer = {
    username: 'cosmos_u1',
    credentialId: 'cred_1',
    environment: 'dev',
    role: 'user',
    permissions: ['payments:write'],
    organizationId: 'org_1',
    plan: 'pro',
    planSwapFeeBps: 50,
  } as never;
  const MERCHANT = Keypair.random().publicKey();
  const PAYER = Keypair.random().publicKey();
  const FEE_WALLET = Keypair.random().publicKey();
  // 1.5% of 20 is 0.3, plus 0.2 fixed: 0.5.
  const merchantFee = { bps: 150, fixed: '0.2', wallet: FEE_WALLET };

  function build(...lookups: unknown[]) {
    const findUnique = jest.fn();
    for (const row of lookups) findUnique.mockResolvedValueOnce(row);
    const prisma = {
      consumer: { upsert: jest.fn(async () => ({ id: 'c1' })) },
      paymentIntent: {
        findUnique,
        create: jest.fn(async ({ data }: any) => ({
          id: 'pi_new',
          txHash: null,
          reference: null,
          assetDecimals: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        })),
        update: jest.fn(async ({ where, data }: any) => ({
          ...(await prisma.paymentIntent.create.mock.results[0].value),
          id: where.id,
          ...data,
        })),
      },
      webhookEmittedEvent: { create: jest.fn(async () => ({})) },
    } as any;
    const accounts = {
      load: jest.fn(async (_network: string, id: string) =>
        Object.assign(new Account(id, '1'), {
          balances: [{ asset_type: 'native', balance: '100' }],
        }),
      ),
      assertCanReceive: jest.fn(),
    };
    const config = {
      get: () => ({
        network: 'testnet',
        baseFee: '100',
        timeoutSeconds: 300,
        ttlSeconds: 3600,
        checkoutUrl: 'https://payments.example',
        apiUrl: 'https://api.example/cosmos-api',
      }),
    } as never;
    // A Solana link: the asset resolves as SOL, the reference is fixed.
    const chainLinks = {
      normalize: (_chain: string, dto: { destination: string }) => ({
        destination: dto.destination,
        asset: 'native',
        assetIssuer: null,
      }),
      build: jest.fn(async (_chain: string, req: { destination: string }) => ({
        destination: req.destination,
        asset: 'native',
        assetIssuer: null,
        assetDecimals: null,
        uri: `solana:${req.destination}?reference=REF`,
        chainReference: 'REF',
        chainCursor: null,
        networkFee: null,
        deposit: null,
      })),
      assertFeeWalletCanReceive: jest.fn(),
    };
    const service = new PaymentIntentsService(
      config,
      prisma,
      new WebhookTerminalEmitter(prisma, { emit: jest.fn() } as never),
      {} as never,
      new Sep7LinkBuilder(
        config,
        { passphrase: () => Networks.TESTNET } as never,
        accounts as never,
      ),
      new ConsumerResolverService(prisma),
      { ensureForPayer: jest.fn() } as never,
      chainLinks as never,
    );
    return { service, prisma, accounts, chainLinks };
  }

  const record = (paidBy: 'recipient' | 'payer') => ({
    bps: 150,
    fixed: '0.2',
    amount: '0.5',
    asset: 'native',
    wallet: FEE_WALLET,
    paidBy,
  });
  const errorOf = (p: Promise<unknown>) =>
    p.then(() => null).catch((e: unknown) => e as ApiError);

  it('puts both payments in a tx intent envelope, the fee after the merchant leg', async () => {
    const { service, prisma, accounts } = build(null);

    const view = await service.createTx(consumer, {
      source: PAYER,
      destination: MERCHANT,
      amount: '20',
      memo: '7',
      merchantFee,
    });

    const tx = TransactionBuilder.fromXDR(
      view.xdr!,
      Networks.TESTNET,
    ) as Transaction;
    const [merchant, fee] = tx.operations as Operation.Payment[];
    expect(merchant.destination).toBe(MERCHANT);
    expect(merchant.amount).toBe('19.5000000');
    expect(fee.destination).toBe(FEE_WALLET);
    expect(fee.amount).toBe('0.5000000');
    expect(
      prisma.paymentIntent.create.mock.calls[0][0].data.merchantFee,
    ).toEqual(record('recipient'));
    expect(view.merchantFee).toEqual(record('recipient'));
    // The fee wallet was checked before anyone is asked to sign.
    expect(accounts.assertCanReceive).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: 'native' }),
      FEE_WALLET,
      'the merchant fee',
    );
  });

  it('sends the fee on top of the whole amount when the payer pays it', async () => {
    const { service } = build(null);

    const view = await service.createTx(consumer, {
      source: PAYER,
      destination: MERCHANT,
      amount: '20',
      memo: '8',
      merchantFee: { ...merchantFee, paidBy: 'payer' },
    });

    const tx = TransactionBuilder.fromXDR(
      view.xdr!,
      Networks.TESTNET,
    ) as Transaction;
    const [merchant, fee] = tx.operations as Operation.Payment[];
    expect(merchant.amount).toBe('20.0000000');
    expect(fee.amount).toBe('0.5000000');
  });

  it('sends a pay link with a fee to the hosted checkout instead of a one-account SEP-7 link', async () => {
    const { service, prisma } = build(null);

    const view = await service.createPay(consumer, {
      destination: MERCHANT,
      amount: '20',
      memo: '9',
      merchantFee,
    });

    expect(view.uri).toBe('https://payments.example/pi_new');
    expect(view.uri).not.toContain('web+stellar:pay');
    expect(prisma.paymentIntent.update).toHaveBeenCalledWith({
      where: { id: 'pi_new' },
      data: { uri: 'https://payments.example/pi_new' },
    });
    expect(view.merchantFee).toEqual(record('recipient'));
  });

  it('refuses a fee on an open-amount link, a fee wallet that is the destination and other chains', async () => {
    const { service } = build(null, null);

    expect(
      (
        await errorOf(
          service.createPay(consumer, {
            destination: MERCHANT,
            memo: '10',
            merchantFee,
          }),
        )
      )?.code,
    ).toBe(ApiErrorCode.ValidationFailed);
    expect(
      (
        await errorOf(
          service.createPay(consumer, {
            destination: MERCHANT,
            amount: '20',
            memo: '11',
            merchantFee: { ...merchantFee, wallet: MERCHANT },
          }),
        )
      )?.code,
    ).toBe(ApiErrorCode.ValidationFailed);
    expect(
      (
        await errorOf(
          service.createPay(consumer, {
            chain: 'monad',
            destination: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
            amount: '20',
            memo: '12',
            merchantFee,
          }),
        )
      )?.code,
    ).toBe(ApiErrorCode.MerchantFeeUnsupported);
  });

  it('answers a retry with the same fee, and refuses one with another', async () => {
    const stored = {
      id: 'pi_fee',
      consumerId: 'c1',
      kind: 'PAY',
      chain: 'stellar',
      network: 'testnet',
      source: null,
      destination: MERCHANT,
      amount: '20',
      asset: 'native',
      assetIssuer: null,
      assetDecimals: null,
      memo: '13',
      msg: null,
      callback: null,
      status: 'PENDING',
      xdr: null,
      uri: 'https://payments.example/pi_fee',
      txHash: null,
      reference: null,
      checkoutTheme: null,
      merchantFee: record('recipient'),
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { service } = build(stored, stored);

    const same = await service.createPay(consumer, {
      destination: MERCHANT,
      amount: '20',
      memo: '13',
      merchantFee,
    });
    expect(same.id).toBe('pi_fee');

    const other = await errorOf(
      service.createPay(consumer, {
        destination: MERCHANT,
        amount: '20',
        memo: '13',
        merchantFee: { ...merchantFee, paidBy: 'payer' },
      }),
    );
    expect(other?.code).toBe(ApiErrorCode.IdempotencyConflict);
  });

  it('makes a Solana link with a fee a Solana Pay transaction request on the gateway', async () => {
    const SOL_DEST = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
    const SOL_FEE = 'GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW';
    const { service, prisma, chainLinks } = build(null);

    const view = await service.createPay(consumer, {
      chain: 'solana',
      destination: SOL_DEST,
      amount: '2',
      memo: '14',
      merchantFee: { bps: 250, wallet: SOL_FEE },
    });

    expect(view.uri).toBe(
      'solana:' +
        encodeURIComponent(
          'https://api.example/cosmos-api/v1/payment-links/pi_new/solana-pay',
        ),
    );
    // 2.5% of 2 SOL, in SOL.
    expect(
      prisma.paymentIntent.create.mock.calls[0][0].data.merchantFee,
    ).toEqual({
      bps: 250,
      fixed: '0',
      amount: '0.05',
      asset: 'native',
      wallet: SOL_FEE,
      paidBy: 'recipient',
    });
    expect(chainLinks.assertFeeWalletCanReceive).toHaveBeenCalledWith(
      'solana',
      'testnet',
      SOL_FEE,
      null,
    );
  });
});
