import {
  Account,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import type { PaymentIntent } from '@generated/prisma/client';
import { decodeBase58, encodeBase58 } from '@/chains/chain-address';
import { SolanaPayTransactionBuilder } from '@/payment-intents/solana-pay-transaction.builder';
import { parseSolanaTransaction } from '@/solana/solana-transaction';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  PAYMENT_LINK_SELECT,
  PaymentLinksService,
  toPublicPaymentLink,
} from '@/payment-intents/payment-links.service';
import {
  CHECKOUT_THEMES,
  DEFAULT_CHECKOUT_THEME,
} from '@/payment-intents/payment-intents.constants';
import { PaymentIntentsService } from '@/payment-intents/payment-intents.service';
import { Sep7LinkBuilder } from '@/payment-intents/sep7-link-builder.service';
import { sep7Qr } from '@/stellar/sep7';

/** Exactly what `GET /v1/payment-links/{id}` promises — no more, no less. */
const CONTRACT_FIELDS = [
  'id',
  'kind',
  'chain',
  'network',
  'status',
  'payTo',
  'amount',
  'asset',
  'assetIssuer',
  'memo',
  'msg',
  'uri',
  'qr',
  'txHash',
  'networkFee',
  'merchantFee',
  'payerAccountRequired',
  'expiresAt',
  'createdAt',
  'checkoutTheme',
].sort();

/** What a payer must never be handed, whatever the row holds. */
const FORBIDDEN_FIELDS = [
  'consumerId',
  'consumer',
  'source',
  'xdr',
  'reference',
  'callback',
  'destination',
  'chainReference',
  'chainCursor',
  'assetDecimals',
  'transitions',
  'settlement',
  'evmDeposit',
  'horizonCursor',
  'updatedAt',
];

const MERCHANT = 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO';
const PAYER = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
const EVM_MERCHANT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const DEPOSIT = '0xC830d264C14ebDB31cdEa0Fb6f83C5b0D8EEc52F';
const CREATED = new Date('2026-10-24T12:34:56.000Z');
const EXPIRES = new Date('2026-10-24T13:34:56.000Z');

/**
 * A FULL row, every column the owner's view holds and then some — the shape a
 * careless spread would leak. `toPublicPaymentLink` accepts it (a full row is
 * assignable to the narrower select), which is exactly why it must not spread.
 */
function fullRow(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    id: 'cmh4x2k9a0001l70g8v5q3z2w',
    consumerId: 'consumer_secret_id',
    merchantFee: null,
    kind: 'PAY',
    chain: 'stellar',
    source: PAYER,
    destination: MERCHANT,
    amount: '25.5',
    asset: 'native',
    assetIssuer: null,
    assetDecimals: null,
    memo: '4127759120438726917',
    network: 'public',
    chainReference: null,
    networkFee: null,
    chainCursor: null,
    msg: 'Order #24',
    callback: 'url:https://merchant.example/hooks/sep7?token=s3cr3t',
    status: 'PENDING',
    xdr: 'AAAAAgAAAAB-envelope-the-payer-must-not-be-handed',
    uri:
      `web+stellar:pay?destination=${MERCHANT}&amount=25.5` +
      '&memo=4127759120438726917&memo_type=MEMO_ID&msg=Order+%2324',
    txHash: null,
    reference: 'merchant-order-24',
    checkoutTheme: null,
    expiresAt: EXPIRES,
    createdAt: CREATED,
    updatedAt: new Date('2026-10-24T12:40:00.000Z'),
    ...overrides,
  };
}

describe('toPublicPaymentLink', () => {
  it('answers exactly the contract fields, values copied as stored', () => {
    const link = toPublicPaymentLink(fullRow(), 'data:image/png;base64,QR');

    expect(Object.keys(link).sort()).toEqual(CONTRACT_FIELDS);
    expect(link).toEqual({
      id: 'cmh4x2k9a0001l70g8v5q3z2w',
      kind: 'PAY',
      chain: 'stellar',
      network: 'public',
      status: 'PENDING',
      payTo: MERCHANT,
      amount: '25.5',
      asset: 'native',
      assetIssuer: null,
      memo: '4127759120438726917',
      msg: 'Order #24',
      uri: fullRow().uri,
      qr: 'data:image/png;base64,QR',
      txHash: null,
      networkFee: null,
      merchantFee: null,
      payerAccountRequired: false,
      expiresAt: '2026-10-24T13:34:56.000Z',
      createdAt: '2026-10-24T12:34:56.000Z',
      checkoutTheme: 'classic',
    });
  });

  it('drops every owner-only column, even handed the full row', () => {
    const row = fullRow();
    const link = toPublicPaymentLink(row, 'qr');
    for (const field of FORBIDDEN_FIELDS) {
      expect(link).not.toHaveProperty(field);
    }
    // Nor do their values ride along under another name.
    const wire = JSON.stringify(link);
    for (const secret of [
      row.consumerId,
      row.source!,
      row.xdr!,
      row.callback!,
      row.reference!,
    ]) {
      expect(wire).not.toContain(secret);
    }
  });

  it('points a Monad payer at the deposit address and hides the merchant', () => {
    const uri = `ethereum:${DEPOSIT}@143?value=1000000000000000000`;
    const link = toPublicPaymentLink(
      fullRow({
        chain: 'monad',
        source: null,
        xdr: null,
        callback: null,
        msg: null,
        destination: EVM_MERCHANT,
        chainReference: DEPOSIT,
        networkFee: '0.02',
        amount: '1',
        uri,
      }),
      'qr',
    );

    expect(link.payTo).toBe(DEPOSIT);
    expect(link.uri).toContain(link.payTo);
    expect(link.networkFee).toBe('0.02');
    // The merchant's own address is the forwarder's business, not the payer's.
    expect(JSON.stringify(link)).not.toContain(EVM_MERCHANT);
  });

  it('points a Monad payer at the merchant when there is no deposit address', () => {
    const link = toPublicPaymentLink(
      fullRow({
        chain: 'monad',
        destination: EVM_MERCHANT,
        chainReference: null,
        uri: `ethereum:${EVM_MERCHANT}@143?value=1000000000000000000`,
      }),
      'qr',
    );
    expect(link.payTo).toBe(EVM_MERCHANT);
  });

  it('never points a Solana payer at the reference key', () => {
    const recipient = 'mvines9iiHiQTysrwkJjGf2gb9Ex9jXJX8ns3qwf2kN';
    const reference = 'GoK3e9dYcQe5jGP3VHkD5nN3CMaoJkUe5ZQ3s1rGHEPx';
    const link = toPublicPaymentLink(
      fullRow({
        chain: 'solana',
        destination: recipient,
        chainReference: reference,
        uri: `solana:${recipient}?amount=1.5&reference=${reference}&memo=42`,
      }),
      'qr',
    );
    expect(link.payTo).toBe(recipient);
    expect(link).not.toHaveProperty('chainReference');
  });

  it('answers a null expiry as null', () => {
    expect(toPublicPaymentLink(fullRow({ expiresAt: null }), 'qr')).toEqual(
      expect.objectContaining({ expiresAt: null }),
    );
  });

  it.each(CHECKOUT_THEMES)(
    'tells the page to draw the %s design the merchant chose',
    (theme) => {
      const link = toPublicPaymentLink(fullRow({ checkoutTheme: theme }), 'qr');
      expect(link.checkoutTheme).toBe(theme);
    },
  );

  it('answers the default design for an intent that names none', () => {
    // Stored null: the intent predates the column or was created without one.
    // The page is told the design outright rather than left to read null.
    const link = toPublicPaymentLink(fullRow({ checkoutTheme: null }), 'qr');
    expect(link.checkoutTheme).toBe(DEFAULT_CHECKOUT_THEME);
    expect(link.checkoutTheme).toBe('classic');
  });

  it('answers the default design for a stored one this release does not draw', () => {
    const link = toPublicPaymentLink(
      fullRow({ checkoutTheme: 'retired-design' }),
      'qr',
    );
    expect(link.checkoutTheme).toBe('classic');
  });

  it('refuses a row on a chain it does not know rather than guess its payee', () => {
    expect(() =>
      toPublicPaymentLink(fullRow({ chain: 'bitcoin' }), 'qr'),
    ).toThrow(/unknown chain/);
  });
});

describe('PaymentLinksService.findPublic', () => {
  const links = new Sep7LinkBuilder({} as never, {} as never, {} as never);

  function make(row: PaymentIntent | null) {
    const findUnique = jest.fn().mockResolvedValue(row);
    const service = new PaymentLinksService(
      { paymentIntent: { findUnique } } as never,
      links,
      {} as never,
      {} as never,
    );
    return { service, findUnique };
  }

  it('loads only the columns the public view is built from', async () => {
    const { service, findUnique } = make(fullRow());
    await service.findPublic('cmh4x2k9a0001l70g8v5q3z2w');

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'cmh4x2k9a0001l70g8v5q3z2w' },
      select: PAYMENT_LINK_SELECT,
    });
    // Not loading them is the first line of keeping them out. `destination`
    // and `chainReference` are loaded only to work out `payTo`.
    for (const column of [
      'consumerId',
      'consumer',
      'source',
      'xdr',
      'reference',
      'callback',
      'transitions',
      'settlement',
      'evmDeposit',
    ]) {
      expect(PAYMENT_LINK_SELECT).not.toHaveProperty(column);
    }
  });

  it('derives the QR from the stored link, as the owner’s read does', async () => {
    const row = fullRow();
    const { service } = make(row);
    const link = await service.findPublic(row.id);
    expect(link.qr).toBe(await sep7Qr(row.uri));
    expect(link.qr).toMatch(/^data:image\/png;base64,/);
  });

  it('answers an unknown id with the owner’s not-found, word for word', async () => {
    const id = 'cmh4x2k9a0001l70g8v5q3z2w';
    const { service } = make(null);
    const publicError = await service.findPublic(id).catch((e: unknown) => e);

    // The owner's `GET /v1/payment-intents/{id}` on a miss.
    const owners = new PaymentIntentsService(
      {} as never,
      {
        paymentIntent: { findFirst: jest.fn().mockResolvedValue(null) },
      } as never,
      {} as never,
      {} as never,
      links,
      {} as never,
      {} as never,
      {} as never,
    );
    const ownerError = await owners
      .findOne({ username: 'cosmos_u1' } as never, id)
      .catch((e: unknown) => e);

    expect(publicError).toBeInstanceOf(ApiError);
    expect((publicError as ApiError).getStatus()).toBe(404);
    expect((publicError as ApiError).code).toBe(ApiErrorCode.NotFound);
    expect((publicError as ApiError).getResponse()).toEqual(
      (ownerError as ApiError).getResponse(),
    );
  });
});

describe('PaymentLinksService.payerTransaction (a Stellar link with a merchant fee)', () => {
  const PAYER = Keypair.random().publicKey();
  const FEE_WALLET = Keypair.random().publicKey();
  const merchantFee = {
    bps: 150,
    fixed: '0.1',
    amount: '0.4825',
    asset: 'native',
    wallet: FEE_WALLET,
    paidBy: 'recipient',
  };
  const accounts = {
    load: jest.fn(async (_network: string, address: string) =>
      Object.assign(new Account(address, '41'), {
        balances: [{ asset_type: 'native', balance: '100' }],
      }),
    ),
    assertCanReceive: jest.fn(),
  };
  const links = new Sep7LinkBuilder(
    {
      get: () => ({ baseFee: '100', timeoutSeconds: 300 }),
    } as never,
    { passphrase: () => Networks.PUBLIC } as never,
    accounts as never,
  );

  function make(row: PaymentIntent | null) {
    return new PaymentLinksService(
      {
        paymentIntent: { findUnique: jest.fn().mockResolvedValue(row) },
      } as never,
      links,
      {} as never,
      {} as never,
    );
  }

  it('says a fee link needs its payer, and shows the fee', () => {
    const link = toPublicPaymentLink(fullRow({ merchantFee }), 'qr');
    expect(link.payerAccountRequired).toBe(true);
    expect(link.merchantFee).toEqual(merchantFee);
  });

  it('builds both payments, with the link memo, on the payer account', async () => {
    const service = make(fullRow({ merchantFee }));

    const built = await service.payerTransaction(
      'cmh4x2k9a0001l70g8v5q3z2w',
      PAYER,
    );

    const tx = TransactionBuilder.fromXDR(
      built.xdr,
      Networks.PUBLIC,
    ) as Transaction;
    expect(tx.source).toBe(PAYER);
    expect(tx.memo.type).toBe('id');
    expect(String(tx.memo.value)).toBe('4127759120438726917');
    const [merchant, fee] = tx.operations as Operation.Payment[];
    // 25.5 less the 0.4825 fee the recipient pays.
    expect(merchant.destination).toBe(MERCHANT);
    expect(merchant.amount).toBe('25.0175000');
    expect(fee.destination).toBe(FEE_WALLET);
    expect(fee.amount).toBe('0.4825000');
    expect(built.uri).toMatch(/^web\+stellar:tx\?xdr=/);
    expect(built.qr).toMatch(/^data:image\/png;base64,/);
  });

  it('refuses a link that pays its destination directly', async () => {
    const err = await make(fullRow())
      .payerTransaction('cmh4x2k9a0001l70g8v5q3z2w', PAYER)
      .catch((e: unknown) => e);
    expect((err as ApiError).code).toBe(ApiErrorCode.ValidationFailed);
  });

  it('refuses a link that is no longer open', async () => {
    const err = await make(fullRow({ merchantFee, status: 'EXPIRED' }))
      .payerTransaction('cmh4x2k9a0001l70g8v5q3z2w', PAYER)
      .catch((e: unknown) => e);
    expect((err as ApiError).code).toBe(ApiErrorCode.InvalidStateTransition);
  });
});

describe('PaymentLinksService Solana Pay (a Solana link with a merchant fee)', () => {
  const k = (n: number) => encodeBase58(new Uint8Array(32).fill(n));
  const MERCHANT_SOL = k(2);
  const FEE_SOL = k(3);
  const REFERENCE = k(4);
  const PAYER_SOL = k(1);
  const solanaRow = (over: Record<string, unknown> = {}) =>
    fullRow({
      chain: 'solana',
      destination: MERCHANT_SOL,
      chainReference: REFERENCE,
      amount: '1.5',
      asset: 'native',
      assetIssuer: null,
      assetDecimals: null,
      memo: '42',
      merchantFee: {
        bps: 0,
        fixed: '0.05',
        amount: '0.05',
        asset: 'native',
        wallet: FEE_SOL,
        paidBy: 'recipient',
      },
      ...over,
    });
  const rpc = {
    getLatestBlockhash: jest.fn().mockResolvedValue(k(9)),
    getAccountOwner: jest.fn(),
  };
  const config = {
    get: () => ({ checkoutUrl: 'https://payments.example' }),
  } as never;
  function make(row: PaymentIntent | null) {
    return new PaymentLinksService(
      {
        paymentIntent: { findUnique: jest.fn().mockResolvedValue(row) },
      } as never,
      new Sep7LinkBuilder({} as never, {} as never, {} as never),
      new SolanaPayTransactionBuilder(rpc as never),
      config,
    );
  }

  it('answers the label and icon a wallet shows', async () => {
    await expect(
      make(solanaRow()).solanaPayInfo('cmh4x2k9a0001l70g8v5q3z2w'),
    ).resolves.toEqual({
      label: 'Cosmos Pay',
      icon: 'https://payments.example/android-chrome-512x512.png',
    });
  });

  it('builds the memo, the merchant leg carrying the reference, and the fee', async () => {
    const answer = await make(solanaRow()).solanaPayTransaction(
      'cmh4x2k9a0001l70g8v5q3z2w',
      PAYER_SOL,
    );

    const tx = parseSolanaTransaction(
      Buffer.from(answer.transaction, 'base64'),
    );
    expect(tx.signers).toEqual([PAYER_SOL]);
    const bytes = Buffer.from(tx.message);
    const has = (key: string) =>
      bytes.includes(Buffer.from(decodeBase58(key)!));
    for (const key of [MERCHANT_SOL, FEE_SOL, REFERENCE, k(9)]) {
      expect(has(key)).toBe(true);
    }
    // 1.5 SOL less a 0.05 fee: 1.45 SOL (1,450,000,000 lamports) to the
    // merchant, 50,000,000 to the fee wallet, as System Transfer data.
    const lamports = (n: bigint) => {
      const b = Buffer.alloc(12);
      b.writeUInt32LE(2, 0);
      b.writeBigUInt64LE(n, 4);
      return b;
    };
    expect(bytes.includes(lamports(1_450_000_000n))).toBe(true);
    expect(bytes.includes(lamports(50_000_000n))).toBe(true);
    expect(answer.message).toBe('Order #24');
  });

  it('refuses a link that is not a transaction request, one no longer open, and a bad account', async () => {
    const codeOf = (p: Promise<unknown>) =>
      p.then(() => null).catch((e: ApiError) => e.code);
    expect(
      await codeOf(make(fullRow()).solanaPayInfo('cmh4x2k9a0001l70g8v5q3z2w')),
    ).toBe(ApiErrorCode.ValidationFailed);
    expect(
      await codeOf(
        make(solanaRow({ status: 'EXPIRED' })).solanaPayTransaction(
          'cmh4x2k9a0001l70g8v5q3z2w',
          PAYER_SOL,
        ),
      ),
    ).toBe(ApiErrorCode.InvalidStateTransition);
    expect(
      await codeOf(
        make(solanaRow()).solanaPayTransaction(
          'cmh4x2k9a0001l70g8v5q3z2w',
          'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
        ),
      ),
    ).toBe(ApiErrorCode.ValidationFailed);
  });
});
