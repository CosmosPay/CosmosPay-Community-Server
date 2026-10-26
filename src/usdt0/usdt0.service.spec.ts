import { ConfigService } from '@nestjs/config';
import { PublicRecordTokens } from '@/common/public-record-token';
import {
  Account,
  Address,
  Contract,
  Keypair,
  nativeToScVal,
  Networks,
  rpc,
  scValToNative,
  SorobanDataBuilder,
  type Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import type { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { PrismaService } from '@/prisma/prisma.service';
import type { StellarAccountLoader } from '@/stellar/account-loader.service';
import type { SorobanRpcClient } from '@/stellar/soroban-rpc.client';
import type { LayerZeroScanClient } from '@/usdt0/layerzero-scan.client';
import { Usdt0OftClient } from '@/usdt0/usdt0-oft.client';
import { Usdt0TransferTracker } from '@/usdt0/usdt0-transfer-tracker.service';
import { Usdt0Service } from '@/usdt0/usdt0.service';
import {
  USDT0_CHAIN_IDS,
  USDT0_ISSUER,
  USDT0_OFT,
} from '@/usdt0/usdt0.constants';

jest.mock('qrcode', () => ({
  __esModule: true,
  default: {
    toDataURL: jest.fn().mockResolvedValue('data:image/png;base64,qq'),
  },
}));

const holder = Keypair.random();
const SOURCE = holder.publicKey();
const RECIPIENT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const GUID = `0x${'ab'.repeat(32)}`;

const prod: GatewayConsumer = {
  username: 'cosmos_public',
  credentialId: null,
  environment: 'prod',
  role: 'public',
  permissions: ['swaps:read', 'swaps:write'],
  organizationId: null,
  plan: null,
  planSwapFeeBps: 50,
};
const dev: GatewayConsumer = { ...prod, environment: 'dev' };

// ── Soroban values as the OFT returns them ─────────────────────────────────

function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map(
        (key) =>
          new xdr.ScMapEntry({
            key: xdr.ScVal.scvSymbol(key),
            val: fields[key],
          }),
      ),
  );
}
const i128 = (n: bigint) => nativeToScVal(n, { type: 'i128' });

/** quote_oft for `amountLd`: the dust dropped, no OFT fee, the real limits. */
function quoteOftRetval(
  amountLd: bigint,
  limits = { min: 0n, max: 18_446_744_073_709_551_615n },
) {
  const sent = amountLd - (amountLd % 10n);
  return xdr.ScVal.scvVec([
    struct({
      max_amount_ld: i128(limits.max),
      min_amount_ld: i128(limits.min),
    }),
    xdr.ScVal.scvVec([]),
    struct({ amount_received_ld: i128(sent), amount_sent_ld: i128(sent) }),
  ]);
}

const NATIVE_FEE = 35_395_007n; // 3.5395007 XLM: the mainnet quote to Ethereum
const RESOURCE_FEE = 14_522_390n;

function sendRetval(guid = GUID) {
  return xdr.ScVal.scvVec([
    struct({
      fee: struct({ native_fee: i128(NATIVE_FEE), zro_fee: i128(0n) }),
      guid: xdr.ScVal.scvBytes(Buffer.from(guid.slice(2), 'hex')),
      nonce: nativeToScVal(31n, { type: 'u64' }),
    }),
    struct({
      amount_received_ld: i128(125_000_000n),
      amount_sent_ld: i128(125_000_000n),
    }),
  ]);
}

function sourceAuth(): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function:
        xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: new Address(USDT0_OFT).toScAddress(),
            functionName: 'send',
            args: [],
          }),
        ),
      subInvocations: [],
    }),
  });
}

/** The contract call a transaction makes: its function and native args. */
function callOf(tx: Transaction) {
  const op = tx.operations[0] as unknown as {
    type: string;
    func: {
      type: string;
      invokeContract: {
        contractAddress: xdr.ScAddress;
        functionName: unknown;
        args: xdr.ScVal[];
      };
    };
    auth: xdr.SorobanAuthorizationEntry[];
  };
  return {
    opType: op.type,
    contract: Address.fromScAddress(
      op.func.invokeContract.contractAddress,
    ).toString(),
    name: String(op.func.invokeContract.functionName),
    args: op.func.invokeContract.args.map((a) => scValToNative(a)),
    auth: op.auth,
  };
}

/** A Soroban RPC that answers the OFT the way mainnet did. */
function fakeRpc() {
  const calls: { name: string; args: unknown[] }[] = [];
  const client = {
    passphrase: Networks.PUBLIC,
    simulate: jest.fn(async (tx: Transaction) => {
      const call = callOf(tx);
      calls.push({ name: call.name, args: call.args });
      const base = { id: '1', latestLedger: 1, events: [], _parsed: true };
      if (call.name === 'quote_oft') {
        const param = call.args[1] as { amount_ld: bigint };
        return {
          ...base,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: '0',
          result: { auth: [], retval: quoteOftRetval(param.amount_ld) },
        };
      }
      if (call.name === 'quote_send') {
        return {
          ...base,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: '0',
          result: {
            auth: [],
            retval: struct({ native_fee: i128(NATIVE_FEE), zro_fee: i128(0n) }),
          },
        };
      }
      return {
        ...base,
        transactionData: new SorobanDataBuilder().setResourceFee(RESOURCE_FEE),
        minResourceFee: String(RESOURCE_FEE),
        result: { auth: [sourceAuth()], retval: sendRetval() },
      };
    }),
    send: jest.fn(async (tx: Transaction) => ({
      status: 'PENDING',
      hash: Buffer.from(tx.hash()).toString('hex'),
      latestLedger: 1,
      latestLedgerCloseTime: 1,
    })),
    getTransaction: jest.fn(async (hash: string) => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      txHash: hash,
      returnValue: sendRetval(),
    })),
  };
  return { client, calls };
}

/** An in-memory `usdt0Transfer` table, enough for the service's queries. */
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
      if (value instanceof Date || row[key] instanceof Date) {
        return (
          (row[key]?.getTime?.() ?? row[key]) ===
          ((value as any)?.getTime?.() ?? value)
        );
      }
      return row[key] === value;
    });
  const table = {
    create: jest.fn(async ({ data }: any) => {
      if (
        rows.some(
          (r) =>
            r.txHash === data.txHash ||
            (data.idempotencyKey &&
              r.consumerId === data.consumerId &&
              r.idempotencyKey === data.idempotencyKey),
        )
      ) {
        throw Object.assign(new Error('unique'), { code: 'P2002' });
      }
      const row = {
        id: `u0_${rows.length + 1}`,
        guid: null,
        destinationTxHash: null,
        scanStatus: null,
        failureReason: null,
        lastCheckedAt: null,
        submittedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        consumer: { apisixUsername: 'cosmos_public' },
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
    findMany: jest.fn(async ({ where }: any) =>
      rows.filter((r) => matches(r, where)),
    ),
    count: jest.fn(
      async ({ where }: any) => rows.filter((r) => matches(r, where)).length,
    ),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
  };
  return { rows, prisma: { usdt0Transfer: table } as unknown as PrismaService };
}

/** The holder's account as Horizon loads it. */
function horizonAccount(opts: { usdt0?: string | null; xlm?: string } = {}) {
  const balances: any[] = [
    { asset_type: 'native', balance: opts.xlm ?? '100' },
  ];
  if (opts.usdt0 !== null) {
    balances.push({
      asset_type: 'credit_alphanum12',
      asset_code: 'USDT0',
      asset_issuer: USDT0_ISSUER,
      balance: opts.usdt0 ?? '500',
    });
  }
  return Object.assign(new Account(SOURCE, '4100'), {
    balances,
    subentry_count: 1,
  });
}

function setup(account = horizonAccount()) {
  const cfg: Record<string, unknown> = {
    stellar: { network: 'testnet', baseFee: '100', timeoutSeconds: 300 },
  };
  const config = { get: (key: string) => cfg[key] } as unknown as ConfigService<
    any,
    true
  >;
  const { rows, prisma } = fakePrisma();
  const { client: rpcClient, calls } = fakeRpc();
  const scan = {
    byGuid: jest.fn().mockResolvedValue(null),
    byTransaction: jest.fn().mockResolvedValue(null),
  };
  const accounts = { load: jest.fn().mockResolvedValue(account) };
  const consumers = {
    resolve: jest.fn().mockResolvedValue({ id: 'consumer_public' }),
  };
  const rpcAsClient = rpcClient as unknown as SorobanRpcClient;
  const oft = new Usdt0OftClient(rpcAsClient);
  const tracker = new Usdt0TransferTracker(
    prisma,
    rpcAsClient,
    scan as unknown as LayerZeroScanClient,
  );
  jest.spyOn(tracker as any, 'pause').mockResolvedValue(undefined);
  const service = new Usdt0Service(
    config,
    prisma,
    consumers as unknown as ConsumerResolverService,
    accounts as unknown as StellarAccountLoader,
    rpcAsClient,
    oft,
    tracker,
    new PublicRecordTokens({
      get: () => ({
        publicConsumer: 'cosmos_public',
        gatewaySecret: 'spec-gateway-secret-spec-gateway-secret',
      }),
    } as never),
  );
  return { service, rows, rpc: rpcClient, calls, scan, accounts };
}

const DTO = {
  source: SOURCE,
  to: 'eth' as const,
  recipient: RECIPIENT,
  amount: '12.5000001',
};

async function refusal(
  promise: Promise<unknown>,
): Promise<{ code: string; message: string; status: number }> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) {
      const body = err.getResponse() as { message: string };
      return { code: err.code, message: body.message, status: err.getStatus() };
    }
    throw err;
  }
  throw new Error('expected a refusal');
}

function signed(xdrB64: string, signer = holder): string {
  const tx = TransactionBuilder.fromXDR(xdrB64, Networks.PUBLIC) as Transaction;
  tx.sign(signer);
  return tx.toXDR();
}

// ── Routes ─────────────────────────────────────────────────────────────────

describe('Usdt0Service.routes', () => {
  it('lists every route on mainnet, Ethereum first and receiving native USDT', () => {
    const { service } = setup();
    const body = service.routes(prod);
    expect(body).toMatchObject({
      network: 'public',
      available: true,
      token: {
        code: 'USDT0',
        issuer: USDT0_ISSUER,
        contract: 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF',
      },
      oft: USDT0_OFT,
      eid: 30600,
    });
    expect(body.routes).toHaveLength(21);
    expect(body.routes[0]).toEqual({
      chain: 'eth',
      name: 'Ethereum',
      eid: 30101,
      receives: 'USDT',
    });
    expect(body.routes.filter((r) => r.receives === 'USDT')).toHaveLength(1);
    expect(body.routes.map((r) => r.chain)).toEqual(USDT0_CHAIN_IDS);
  });

  it('answers a dev key with the same body, unavailable and with no routes', () => {
    const { service } = setup();
    expect(service.routes(dev)).toMatchObject({
      network: 'public',
      available: false,
      routes: [],
    });
  });
});

// ── Quote ──────────────────────────────────────────────────────────────────

describe('Usdt0Service.quote', () => {
  it('maps quote_oft and quote_send: the dust, both fees, the limits', async () => {
    const { service } = setup();
    await expect(
      service.quote(prod, { to: 'arb', amount: '10.0000001' }),
    ).resolves.toEqual({
      to: 'arb',
      eid: 30110,
      receives: 'USDT0',
      amount: '10.0000001',
      amountSent: '10',
      amountReceived: '10',
      dust: '0.0000001',
      nativeFee: '3.5395007',
      nativeFeeLimit: '4.2474009',
      minAmount: '0',
      maxAmount: '1844674407370.9551615',
    });
  });

  it('simulates as the source when one is given, else as the fixed account, with the floor set on quote_send', async () => {
    const { service, calls } = setup();
    await service.quote(prod, { to: 'eth', amount: '1', source: SOURCE });
    await service.quote(prod, { to: 'eth', amount: '1' });
    expect(calls.map((c) => [c.name, c.args[0]])).toEqual([
      ['quote_oft', SOURCE],
      ['quote_send', SOURCE],
      ['quote_oft', USDT0_ISSUER],
      ['quote_send', USDT0_ISSUER],
    ]);
    expect(calls[0].args[1]).toMatchObject({
      dst_eid: 30101,
      min_amount_ld: 0n,
    });
    expect(calls[1].args[1]).toMatchObject({ min_amount_ld: 10_000_000n });
    expect(calls[1].args[2]).toBe(false);
  });

  it('refuses a dev key before asking the RPC: USDT0 is on mainnet only', async () => {
    const { service, rpc: client } = setup();
    const r = await refusal(service.quote(dev, { to: 'eth', amount: '1' }));
    expect(r).toMatchObject({ code: 'network_unsupported', status: 400 });
    expect(r.message).toContain('Stellar mainnet only');
    expect(client.simulate).not.toHaveBeenCalled();
  });

  it('refuses an amount that is all dust before asking the RPC', async () => {
    const { service, rpc: client } = setup();
    const r = await refusal(
      service.quote(prod, { to: 'eth', amount: '0.0000009' }),
    );
    expect(r.code).toBe('invalid_amount');
    expect(client.simulate).not.toHaveBeenCalled();
  });

  it('refuses an amount above the OFT limit', async () => {
    const { service, rpc: client } = setup();
    client.simulate.mockImplementationOnce(async () => ({
      id: '1',
      latestLedger: 1,
      events: [],
      _parsed: true,
      transactionData: new SorobanDataBuilder(),
      minResourceFee: '0',
      result: {
        auth: [],
        retval: quoteOftRetval(100_000_000n, { min: 0n, max: 50_000_000n }),
      },
    }));
    const r = await refusal(service.quote(prod, { to: 'eth', amount: '10' }));
    expect(r).toMatchObject({ code: 'invalid_amount' });
    expect(r.message).toContain('maximum of 5 USDT0');
  });

  it('relays a contract refusal as provider_error with the contract error', async () => {
    const { service, rpc: client } = setup();
    client.simulate.mockImplementationOnce(
      async () =>
        ({
          id: '1',
          latestLedger: 1,
          events: [],
          _parsed: true,
          error:
            'HostError: Error(Contract, #2001)\n\nEvent log (newest first): ...',
        }) as never,
    );
    const r = await refusal(service.quote(prod, { to: 'eth', amount: '10' }));
    expect(r).toMatchObject({ code: 'provider_error', status: 400 });
    expect(r.message).toBe(
      'The USDT0 contract refused the quote (quote_oft): HostError: Error(Contract, #2001)',
    );
  });
});

// ── Create ─────────────────────────────────────────────────────────────────

describe('Usdt0Service.create', () => {
  it('builds ONE invokeHostFunction calling send on the OFT with the right arguments', async () => {
    const { service, rows } = setup();
    const view = await service.create(prod, DTO);

    const tx = TransactionBuilder.fromXDR(
      view.xdr,
      Networks.PUBLIC,
    ) as Transaction;
    expect(tx.source).toBe(SOURCE);
    expect(tx.sequence).toBe('4101');
    expect(tx.signatures).toHaveLength(0);
    expect(tx.operations).toHaveLength(1);
    const call = callOf(tx);
    expect(call.opType).toBe('invokeHostFunction');
    expect(call.contract).toBe(USDT0_OFT);
    expect(call.name).toBe('send');
    const [from, param, fee, refund] = call.args as [string, any, any, string];
    expect(from).toBe(SOURCE);
    expect(refund).toBe(SOURCE);
    expect(param).toMatchObject({
      dst_eid: 30101,
      // The dust-free amount, and the floor from quote_oft.
      amount_ld: 125_000_000n,
      min_amount_ld: 125_000_000n,
    });
    expect(Buffer.from(param.to).toString('hex')).toBe(
      `${'00'.repeat(12)}${RECIPIENT.slice(2).toLowerCase()}`,
    );
    // The quote plus the 20% buffer, refunded in the transaction if unused.
    expect(fee).toEqual({ native_fee: 42_474_009n, zro_fee: 0n });
    // Assembled: the source-account auth and the resource fee.
    expect(call.auth.map((a) => a.credentials.type)).toEqual([
      'sorobanCredentialsSourceAccount',
    ]);
    expect(tx.fee).toBe(String(100n + RESOURCE_FEE));

    expect(rows[0]).toMatchObject({
      status: 'PENDING',
      network: 'public',
      to: 'eth',
      eid: 30101,
      receives: 'USDT',
      recipient: RECIPIENT,
      amount: '12.5000001',
      amountSent: '12.5',
      amountReceived: '12.5',
      nativeFee: '3.5395007',
      nativeFeeLimit: '4.2474009',
      networkFee: '1.452249',
      txHash: Buffer.from(tx.hash()).toString('hex'),
    });
    expect(view).toMatchObject({
      status: 'PENDING',
      dust: '0.0000001',
      // Not on the network yet: no hash to look up, nothing on Scan.
      txHash: null,
      scanUrl: null,
      uri: `web+stellar:tx?xdr=${encodeURIComponent(view.xdr)}`,
    });
    expect(view.expiresAt.getTime()).toBe(
      Number(tx.timeBounds!.maxTime) * 1000,
    );
    expect(view).not.toHaveProperty('consumerId');
    expect(view).not.toHaveProperty('lastCheckedAt');
  });

  it('stores the recipient EIP-55, from a lowercase address', async () => {
    const { service, rows } = setup();
    await service.create(prod, { ...DTO, recipient: RECIPIENT.toLowerCase() });
    expect(rows[0].recipient).toBe(RECIPIENT);
  });

  it.each([
    ['a dev key', { consumer: dev }, 'network_unsupported'],
    [
      'a mixed-case recipient with a bad checksum',
      { dto: { recipient: '0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed' } },
      'validation_failed',
    ],
    [
      'the zero address',
      { dto: { recipient: `0x${'0'.repeat(40)}` } },
      'validation_failed',
    ],
    [
      'an amount that is all dust',
      { dto: { amount: '0.0000001' } },
      'invalid_amount',
    ],
    [
      'a source without the USDT0 trustline',
      { account: horizonAccount({ usdt0: null }) },
      'trustline_missing',
    ],
    [
      'a source holding too little USDT0',
      { account: horizonAccount({ usdt0: '12.4999999' }) },
      'insufficient_balance',
    ],
  ] as const)(
    'refuses %s before building anything',
    async (_label, opts: any, code) => {
      const { service, rpc: client, rows } = setup(opts.account);
      const r = await refusal(
        service.create(opts.consumer ?? prod, { ...DTO, ...(opts.dto ?? {}) }),
      );
      expect(r.code).toBe(code);
      expect(client.simulate).not.toHaveBeenCalled();
      expect(rows).toHaveLength(0);
    },
  );

  it('refuses a source that cannot pay the fees in XLM, saying how much to add', async () => {
    // Minimum 1.5 XLM (one subentry) + 4.2474009 + 1.452249 = 7.1996499.
    const { service, rows } = setup(horizonAccount({ xlm: '7' }));
    const r = await refusal(service.create(prod, DTO));
    expect(r.code).toBe('insufficient_balance');
    expect(r.message).toContain('Add at least 0.1996499 XLM');
    expect(rows).toHaveLength(0);
  });

  it('refuses an account Horizon does not know with the loader’s 400', async () => {
    const { service, accounts } = setup();
    accounts.load.mockRejectedValueOnce(
      ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `Account ${SOURCE} not found or not funded on the public network`,
      ),
    );
    const r = await refusal(service.create(prod, DTO));
    expect(r.code).toBe('validation_failed');
    expect(r.message).toContain('not found');
  });

  it('answers a same-key replay with the stored transfer, unchanged and without the RPC', async () => {
    const { service, rpc: client, rows } = setup();
    const first = await service.create(prod, DTO, 'key-1');
    client.simulate.mockClear();
    const again = await service.create(
      prod,
      { ...DTO, recipient: RECIPIENT.toLowerCase() },
      'key-1',
    );
    expect(again).toEqual(first);
    expect(client.simulate).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it('refuses the same key with a different request (409)', async () => {
    const { service } = setup();
    await service.create(prod, DTO, 'key-1');
    const r = await refusal(
      service.create(prod, { ...DTO, to: 'arb' }, 'key-1'),
    );
    expect(r).toMatchObject({ code: 'idempotency_conflict', status: 409 });
  });
});

// ── Submit ─────────────────────────────────────────────────────────────────

describe('Usdt0Service.submit', () => {
  async function built() {
    const ctx = setup();
    const view = await ctx.service.create(prod, DTO);
    return { ...ctx, view };
  }

  it('refuses another transaction before saying anything about the transfer', async () => {
    const { service, view, rpc: client } = await built();
    const other = new TransactionBuilder(new Account(SOURCE, '1'), {
      fee: '100',
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(new Contract(USDT0_OFT).call('send'))
      .setTimeout(300)
      .build();
    other.sign(holder);
    const r = await refusal(
      service.submit(prod, view.id, other.toXDR(), view.publicToken),
    );
    expect(r).toMatchObject({
      code: 'validation_failed',
      message: 'The signed transaction does not match this transfer',
    });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('refuses the unsigned envelope', async () => {
    const { service, view, rpc: client } = await built();
    const r = await refusal(
      service.submit(prod, view.id, view.xdr, view.publicToken),
    );
    expect(r.message).toMatch(/carries no signatures/);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('relays the signed transaction and stores the hash and the guid from send', async () => {
    const { service, view, rpc: client, rows } = await built();
    const outcome = await service.submit(
      prod,
      view.id,
      signed(view.xdr),
      view.publicToken,
    );
    expect(client.send).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      submitted: true,
      status: 'SUBMITTED',
      txHash: rows[0].txHash,
      transfer: {
        status: 'SUBMITTED',
        guid: GUID,
        txHash: rows[0].txHash,
        scanUrl: `https://layerzeroscan.com/tx/${rows[0].txHash}`,
      },
    });
    expect(rows[0].submittedAt).toBeInstanceOf(Date);
  });

  it('answers an accepted transaction not yet applied as SUBMITTED, guid to follow', async () => {
    const { service, view, rpc: client } = await built();
    client.getTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    } as never);
    const outcome = await service.submit(
      prod,
      view.id,
      signed(view.xdr),
      view.publicToken,
    );
    expect(outcome).toMatchObject({
      submitted: true,
      status: 'SUBMITTED',
      transfer: { guid: null },
    });
  });

  it('records a transaction that failed on the ledger as FAILED, with its codes', async () => {
    const { service, view, rpc: client } = await built();
    client.getTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.FAILED,
      resultXdr: new xdr.TransactionResult({
        feeCharged: 100n,
        result: xdr.TransactionResultResult.txFailed([
          xdr.OperationResult.opInner(
            xdr.OperationResultTr.invokeHostFunction(
              xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped(),
            ),
          ),
        ]),
        ext: xdr.TransactionResultExt.v0(),
      }),
    } as never);
    const outcome = await service.submit(
      prod,
      view.id,
      signed(view.xdr),
      view.publicToken,
    );
    expect(outcome).toMatchObject({ submitted: false, status: 'FAILED' });
    expect(outcome.reason).toContain('tx_failed, invoke_host_function_trapped');
  });

  it('keeps a transfer the network refused PENDING, saying why', async () => {
    const { service, view, rpc: client, rows } = await built();
    client.send.mockResolvedValueOnce({
      status: 'ERROR',
      hash: rows[0].txHash,
      errorResult: new xdr.TransactionResult({
        feeCharged: 0n,
        result: xdr.TransactionResultResult.txBadAuth(),
        ext: xdr.TransactionResultExt.v0(),
      }),
    } as never);
    client.getTransaction.mockResolvedValue({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    } as never);
    const outcome = await service.submit(
      prod,
      view.id,
      signed(view.xdr, Keypair.random()),
      view.publicToken,
    );
    expect(outcome).toMatchObject({ submitted: false, status: 'PENDING' });
    expect(outcome.reason).toContain('(tx_bad_auth)');
    expect(rows[0].status).toBe('PENDING');
  });

  it('settles a refused broadcast the ledger already has (the wallet sent it itself)', async () => {
    const { service, view, rpc: client } = await built();
    client.send.mockResolvedValueOnce({ status: 'ERROR', hash: 'x' } as never);
    const outcome = await service.submit(
      prod,
      view.id,
      signed(view.xdr),
      view.publicToken,
    );
    expect(outcome).toMatchObject({
      submitted: true,
      status: 'SUBMITTED',
      transfer: { guid: GUID },
    });
  });

  it('answers a SUBMITTED transfer again without broadcasting', async () => {
    const { service, view, rpc: client } = await built();
    await service.submit(prod, view.id, signed(view.xdr), view.publicToken);
    client.send.mockClear();
    const again = await service.submit(
      prod,
      view.id,
      signed(view.xdr),
      view.publicToken,
    );
    expect(again).toMatchObject({ submitted: true, status: 'SUBMITTED' });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('refuses an EXPIRED transfer', async () => {
    const { service, view, rows } = await built();
    rows[0].status = 'EXPIRED';
    const r = await refusal(
      service.submit(prod, view.id, signed(view.xdr), view.publicToken),
    );
    expect(r.code).toBe('invalid_state_transition');
  });

  it('refuses a dev key, and a transfer of another consumer as not found', async () => {
    const { service, view } = await built();
    expect((await refusal(service.submit(dev, view.id, 'x'))).code).toBe(
      'network_unsupported',
    );
    const r = await refusal(
      service.submit(
        { ...prod, username: 'cosmos_other' },
        view.id,
        signed(view.xdr),
      ),
    );
    expect(r).toMatchObject({ code: 'not_found', status: 404 });
  });
});

// ── The shared public key's record token ───────────────────────────────────

describe('Usdt0Service record tokens (the shared public key)', () => {
  const realKey: GatewayConsumer = {
    ...prod,
    username: 'cosmos_u1',
    role: 'user',
  };

  it('answers publicToken on create to the shared public key, the same on a replay, and none to a real key', async () => {
    const { service } = setup();
    const first = await service.create(prod, DTO, 'key-1');
    expect(first.publicToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const replay = await service.create(prod, DTO, 'key-1');
    expect(replay.publicToken).toBe(first.publicToken);

    const other = setup();
    const own = await other.service.create(realKey, DTO);
    expect(own).not.toHaveProperty('publicToken');
  });

  it('reads and submits only with the transfer’s own token, and answers a missing or wrong one with the 404 of a missing transfer', async () => {
    const { service, rpc: client } = setup();
    const view = await service.create(prod, DTO);
    const notFound = `USDT0 transfer ${view.id} not found`;

    for (const token of [undefined, '', 'x'.repeat(43), view.id]) {
      const read = await refusal(service.findOne(prod, view.id, token));
      expect(read).toMatchObject({
        status: 404,
        code: 'not_found',
        message: notFound,
      });
      const submit = await refusal(
        service.submit(prod, view.id, signed(view.xdr), token),
      );
      expect(submit).toMatchObject({ status: 404, message: notFound });
    }
    expect(client.send).not.toHaveBeenCalled();

    await expect(
      service.findOne(prod, view.id, view.publicToken),
    ).resolves.toMatchObject({ id: view.id });
  });

  it('leaves a real key as it was: no token asked', async () => {
    const { service, rows } = setup();
    const view = await service.create(realKey, DTO);
    // The in-memory table files every row under the public consumer.
    rows[0].consumer = { apisixUsername: realKey.username };
    await expect(service.findOne(realKey, view.id)).resolves.toMatchObject({
      id: view.id,
    });
  });
});

// ── Read ───────────────────────────────────────────────────────────────────

describe('Usdt0Service reads', () => {
  it('lists only the consumer’s transfers, with the derived fields and no QR', async () => {
    const { service } = setup();
    await service.create(prod, DTO);
    const page = await service.findAll(prod, { take: 20, skip: 0 });
    expect(page).toMatchObject({ total: 1, take: 20, skip: 0 });
    expect(page.data[0]).toMatchObject({
      status: 'PENDING',
      dust: '0.0000001',
      txHash: null,
      scanUrl: null,
    });
    expect(page.data[0]).not.toHaveProperty('qr');
    expect(
      (
        await service.findAll(
          { ...prod, username: 'cosmos_other' },
          { take: 20, skip: 0 },
        )
      ).total,
    ).toBe(0);
  });

  it('lists nothing to a sandbox key: USDT0 transfers are mainnet only', async () => {
    const { service } = setup();
    await service.create(prod, DTO);

    const sandbox = await service.findAll(
      { ...prod, environment: 'dev' },
      { take: 20, skip: 0 },
    );
    expect(sandbox).toMatchObject({ total: 0, data: [] });
  });

  it('refreshes a PENDING transfer from the ledger when it is read', async () => {
    const { service, rpc: client } = setup();
    const view = await service.create(prod, DTO);
    const read = await service.findOne(prod, view.id, view.publicToken);
    expect(client.getTransaction).toHaveBeenCalledTimes(1);
    expect(read).toMatchObject({ status: 'SUBMITTED', guid: GUID });
  });
});
