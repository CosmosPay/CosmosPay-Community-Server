import { HttpStatus } from '@nestjs/common';
import { Account, Keypair, Networks } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { StellarAccountLoader } from '@/stellar/account-loader.service';
import { resolveAsset } from '@/stellar/asset';
import {
  LiquidityPoolReaderService,
  parseReserve,
  reserveOf,
} from '@/liquidity-pools/liquidity-pool-reader.service';
import {
  POSITIONS_MAX_POOL_PAGES,
  POSITIONS_POOL_PAGE_SIZE,
} from '@/liquidity-pools/liquidity-pools.constants';

const POOL_ID = 'dd'.repeat(32);
const SOURCE = Keypair.random().publicKey();
const USDC_ISSUER = Keypair.random().publicKey();

const consumer: GatewayConsumer = {
  username: 'cosmos_u1',
  credentialId: 'cred_1',
  environment: 'dev',
  role: 'user',
  permissions: ['liquidity:read'],
  organizationId: 'org_1',
  plan: 'pro',
  planSwapFeeBps: 50,
};

function stellarConfig() {
  return {
    network: 'testnet',
    baseFee: '100',
    timeoutSeconds: 300,
    horizon: { public: 'https://h', testnet: 'https://h' },
  };
}

function mockHorizonAccount(balances: any[]) {
  const account: any = new Account(SOURCE, '1');
  account.balances = balances;
  account.subentry_count = 1;
  return account;
}

const DEFAULT_BALANCES = [
  { asset_type: 'native', balance: '10000' },
  {
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: USDC_ISSUER,
    balance: '5000',
  },
  {
    asset_type: 'liquidity_pool_shares',
    liquidity_pool_id: POOL_ID,
    balance: '100',
  },
];

function poolRecord(id: string, pagingToken = id) {
  return {
    id,
    paging_token: pagingToken,
    fee_bp: 30,
    total_trustlines: '2',
    total_shares: '100',
    reserves: [
      { asset: 'native', amount: '2000' },
      { asset: `USDC:${USDC_ISSUER}`, amount: '200' },
    ],
  };
}

function reader(stellar: unknown): LiquidityPoolReaderService {
  return new LiquidityPoolReaderService(
    { get: () => stellarConfig() } as any,
    stellar as any,
    new StellarAccountLoader(stellar as never),
  );
}

describe('LiquidityPoolReaderService.positions', () => {
  const OTHER_POOL = 'ee'.repeat(32);

  function shareBalance(poolId: string, balance: string) {
    return {
      asset_type: 'liquidity_pool_shares',
      liquidity_pool_id: poolId,
      balance,
    };
  }

  /**
   * Horizon with a paged `liquidity_pools?account=` listing (one page per
   * entry of `pages`, then empty) and a per-pool lookup that must stay unused.
   */
  function make(balances: any[], pages: any[][]) {
    const call = jest.fn();
    for (const page of pages) call.mockResolvedValueOnce({ records: page });
    call.mockResolvedValue({ records: [] });
    const listing: any = {
      limit: jest.fn(() => listing),
      cursor: jest.fn(() => listing),
      call,
    };
    const forAccount = jest.fn(() => listing);
    const liquidityPoolId = jest.fn();
    const stellar = {
      passphrase: jest.fn().mockReturnValue(Networks.TESTNET),
      server: jest.fn().mockReturnValue({
        loadAccount: jest.fn(async () => mockHorizonAccount(balances)),
        liquidityPools: () => ({ forAccount, liquidityPoolId }),
      }),
    };
    const service = reader(stellar);
    return { service, listing, forAccount, liquidityPoolId };
  }

  it('reads every position from one listing instead of a lookup per pool', async () => {
    // A Horizon request per pool, all at once, was a fan-out anyone holding the
    // shared public key could size by seeding an account with trustlines.
    const { service, listing, forAccount, liquidityPoolId } = make(
      [...DEFAULT_BALANCES, shareBalance(OTHER_POOL, '10')],
      [[poolRecord(OTHER_POOL), poolRecord(POOL_ID)]],
    );

    const result = await service.positions(consumer, { account: SOURCE });

    expect(forAccount).toHaveBeenCalledWith(SOURCE);
    expect(listing.limit).toHaveBeenCalledWith(POSITIONS_POOL_PAGE_SIZE);
    expect(listing.call).toHaveBeenCalledTimes(1);
    expect(liquidityPoolId).not.toHaveBeenCalled();
    // Same shape and order as before: the account's balances, joined to pools.
    expect(result.data.map((p) => p.poolId)).toEqual([POOL_ID, OTHER_POOL]);
    expect(result.data[0]).toEqual({
      poolId: POOL_ID,
      shares: '100',
      totalShares: '100',
      shareOfPoolBps: 10_000,
      reserves: [
        { asset: 'native', issuer: null, amount: '2000' },
        { asset: 'USDC', issuer: USDC_ISSUER, amount: '200' },
      ],
      redeemable: [
        { asset: 'native', issuer: null, amount: '2000' },
        { asset: 'USDC', issuer: USDC_ISSUER, amount: '200' },
      ],
    });
    expect(result.data[1].shareOfPoolBps).toBe(1_000);
  });

  it('drops a share balance whose pool the listing does not return', async () => {
    // What a per-pool 404 used to do.
    const { service } = make(
      [...DEFAULT_BALANCES, shareBalance(OTHER_POOL, '10')],
      [[poolRecord(POOL_ID)]],
    );

    const result = await service.positions(consumer, { account: SOURCE });

    expect(result.data.map((p) => p.poolId)).toEqual([POOL_ID]);
  });

  it('asks Horizon for no pools when the account holds no shares', async () => {
    const { service, forAccount } = make(
      [{ asset_type: 'native', balance: '10' }],
      [],
    );

    const result = await service.positions(consumer, { account: SOURCE });

    expect(result.data).toEqual([]);
    expect(forAccount).not.toHaveBeenCalled();
  });

  it('follows the cursor across full pages and stops at the page cap', async () => {
    const fullPage = (n: number) =>
      Array.from({ length: POSITIONS_POOL_PAGE_SIZE }, (_, i) =>
        poolRecord(`p${n}-${i}`, `token-${n}-${i}`),
      );
    const { service, listing } = make(
      DEFAULT_BALANCES,
      Array.from({ length: POSITIONS_MAX_POOL_PAGES + 2 }, (_, n) =>
        fullPage(n),
      ),
    );

    await service.positions(consumer, { account: SOURCE });

    expect(listing.call).toHaveBeenCalledTimes(POSITIONS_MAX_POOL_PAGES);
    expect(listing.cursor).toHaveBeenCalledWith(
      `token-0-${POSITIONS_POOL_PAGE_SIZE - 1}`,
    );
  });

  it('answers 503 when the listing cannot be read', async () => {
    const { service, listing } = make(DEFAULT_BALANCES, []);
    listing.call.mockRejectedValueOnce(new Error('socket hang up'));

    const err = await service
      .positions(consumer, { account: SOURCE })
      .catch((e) => e);

    expect((err as ApiError).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect((err as ApiError).code).toBe(ApiErrorCode.ProviderUnavailable);
  });
});

describe('LiquidityPoolReaderService pool reads', () => {
  /** Horizon's pool endpoints: a listing builder chain and a lookup by id. */
  function make(opts: { list?: jest.Mock; lookup?: jest.Mock } = {}): {
    service: LiquidityPoolReaderService;
    listing: any;
    liquidityPoolId: jest.Mock;
  } {
    const listing: any = {};
    for (const step of [
      'limit',
      'order',
      'forAssets',
      'forAccount',
      'cursor',
    ]) {
      listing[step] = jest.fn(() => listing);
    }
    listing.call = opts.list ?? jest.fn().mockResolvedValue({ records: [] });
    const lookup =
      opts.lookup ?? jest.fn().mockResolvedValue(poolRecord(POOL_ID));
    const liquidityPoolId = jest.fn(() => ({ call: lookup }));
    const stellar = {
      passphrase: jest.fn().mockReturnValue(Networks.TESTNET),
      server: jest.fn().mockReturnValue({
        liquidityPools: () => ({ ...listing, liquidityPoolId }),
      }),
    };
    return { service: reader(stellar), listing, liquidityPoolId };
  }

  function horizonError(status?: number) {
    return Object.assign(
      new Error('Horizon'),
      status === undefined ? {} : { response: { status } },
    );
  }

  it('lists pools newest first, with a cursor only after a full page', async () => {
    const other = 'aa'.repeat(32);
    const list = jest.fn().mockResolvedValue({
      records: [poolRecord(other, 't1'), poolRecord(POOL_ID, 't2')],
    });
    const { service, listing } = make({ list });

    const full = await service.listPools(consumer, { limit: 2 });

    expect(listing.limit).toHaveBeenCalledWith(2);
    expect(listing.order).toHaveBeenCalledWith('desc');
    expect(full.data.map((p) => p.id)).toEqual([other, POOL_ID]);
    expect(full.data[1]).toEqual({
      id: POOL_ID,
      network: 'testnet',
      feeBp: 30,
      totalTrustlines: '2',
      totalShares: '100',
      reserves: [
        { asset: 'native', issuer: null, amount: '2000' },
        { asset: 'USDC', issuer: USDC_ISSUER, amount: '200' },
      ],
    });
    expect(full.cursor).toBe('t2');

    const short = await service.listPools(consumer, { limit: 3 });
    expect(short.cursor).toBeNull();
  });

  it('filters by the assets, account and cursor it is given', async () => {
    const { service, listing } = make();

    await service.listPools(consumer, {
      limit: 20,
      assetBCode: 'USDC',
      assetBIssuer: USDC_ISSUER,
      account: SOURCE,
      cursor: 'c1',
    });

    expect(listing.forAssets).toHaveBeenCalledTimes(1);
    const [asset] = listing.forAssets.mock.calls[0];
    expect(asset.getCode()).toBe('USDC');
    expect(asset.getIssuer()).toBe(USDC_ISSUER);
    expect(listing.forAccount).toHaveBeenCalledWith(SOURCE);
    expect(listing.cursor).toHaveBeenCalledWith('c1');
  });

  it('answers 503 when the pool listing cannot be read', async () => {
    const list = jest.fn().mockRejectedValue(horizonError(500));
    const { service } = make({ list });

    const err = await service
      .listPools(consumer, { limit: 20 })
      .catch((e) => e);

    expect((err as ApiError).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect((err as ApiError).code).toBe(ApiErrorCode.ProviderUnavailable);
  });

  it('refuses a malformed pool id before asking Horizon', async () => {
    const { service, liquidityPoolId } = make();

    const err = await service
      .getPool(consumer, POOL_ID.toUpperCase())
      .catch((e) => e);

    expect((err as ApiError).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect((err as ApiError).code).toBe(ApiErrorCode.ValidationFailed);
    expect(liquidityPoolId).not.toHaveBeenCalled();
  });

  it('answers 404 for a pool Horizon does not know', async () => {
    const lookup = jest.fn().mockRejectedValue(horizonError(404));
    const { service } = make({ lookup });

    const err = await service.getPool(consumer, POOL_ID).catch((e) => e);

    expect((err as ApiError).getStatus()).toBe(HttpStatus.NOT_FOUND);
  });

  it('reads a Horizon 404 as "no pool yet" and any other failure as 503', async () => {
    // A deposit into an unfunded pool is legitimate, so absence is an answer.
    const lookup = jest
      .fn()
      .mockRejectedValueOnce(horizonError(404))
      .mockRejectedValueOnce(horizonError(429))
      .mockRejectedValueOnce(horizonError());
    const { service } = make({ lookup });

    await expect(service.fetchPool('testnet', POOL_ID)).resolves.toBeNull();
    for (let i = 0; i < 2; i++) {
      const err = await service.fetchPool('testnet', POOL_ID).catch((e) => e);
      expect((err as ApiError).getStatus()).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  });
});

describe('parseReserve and reserveOf', () => {
  it('parses native and issued Horizon reserves', () => {
    expect(parseReserve({ asset: 'native', amount: '1' })).toEqual({
      asset: 'native',
      issuer: null,
      amount: '1',
    });
    expect(
      parseReserve({ asset: `USDC:${USDC_ISSUER}`, amount: '2.5' }),
    ).toEqual({ asset: 'USDC', issuer: USDC_ISSUER, amount: '2.5' });
  });

  it("finds a constituent asset's reserve, and zero for one the pool lacks", () => {
    const pool = poolRecord(POOL_ID);
    expect(reserveOf(pool, resolveAsset('native'))).toBe('2000');
    expect(reserveOf(pool, resolveAsset('USDC', USDC_ISSUER))).toBe('200');
    expect(
      reserveOf(pool, resolveAsset('EURC', Keypair.random().publicKey())),
    ).toBe('0');
  });
});
