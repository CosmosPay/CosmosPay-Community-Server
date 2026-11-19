import { approveCalldata } from '@/evm/erc20';
import { p2pCalldata } from '@/p2p/p2p-market-abi';
import {
  buildBalanceAction,
  buildOrderAction,
  isBalanceAction,
  P2P_TRANSACTION_ACTIONS,
  permissionBits,
  type P2pBalanceContext,
  type P2pOrderContext,
} from '@/p2p/p2p-transaction-actions';

const CONTRACT = '0x5fbDB2315678afecb367f032d93F642f64180aa3';
const MATCHER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const ACCOUNT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const BUYER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const BOT = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
const USDC = {
  symbol: 'USDC',
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  decimals: 6,
};

const balance = (
  overrides: Partial<P2pBalanceContext> = {},
): P2pBalanceContext => ({
  contract: CONTRACT,
  from: ACCOUNT,
  matcher: MATCHER,
  token: (v) =>
    v.toLowerCase() === 'usdc' || v.toLowerCase() === USDC.address.toLowerCase()
      ? USDC
      : null,
  sellsLiquidity: false,
  ...overrides,
});

const NOW = new Date('2026-11-19T12:00:00Z');

const orderCtx = (
  from: string,
  overrides: Partial<P2pOrderContext['order']> = {},
): P2pOrderContext => ({
  contract: CONTRACT,
  from,
  now: NOW,
  order: {
    id: 'o1',
    onchainId: '7',
    status: 'awaiting_payment',
    sellerAddress: ACCOUNT,
    buyerAddress: BUYER,
    tokenAmount: '100000000',
    netAmount: '99500000',
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    acceptDeadline: null,
    paymentDeadline: new Date(NOW.getTime() + 60_000),
    ...overrides,
  },
});

describe('P2P transaction actions', () => {
  it('sorts every action into balance or order', () => {
    const balanceActions = P2P_TRANSACTION_ACTIONS.filter(isBalanceAction);
    expect(balanceActions).toEqual([
      'approve',
      'deposit',
      'withdraw',
      'setOperator',
      'setMatcher',
    ]);
  });

  it('approves the market for the exact amount, on the token', () => {
    const built = buildBalanceAction(
      'approve',
      { token: 'USDC', amount: '25000000' },
      balance(),
    );
    expect(built).toEqual({
      ok: true,
      value: {
        to: USDC.address,
        data: approveCalldata(CONTRACT, 25_000_000n),
        description: 'Allow the P2P market to take exactly 25 USDC',
      },
    });
  });

  it('deposits and withdraws only listed tokens and positive amounts', () => {
    expect(
      buildBalanceAction(
        'deposit',
        { token: USDC.address, amount: '1' },
        balance(),
      ),
    ).toMatchObject({
      ok: true,
      value: { data: p2pCalldata.deposit(USDC.address, 1n) },
    });
    expect(
      buildBalanceAction('withdraw', { token: 'DAI', amount: '1' }, balance()),
    ).toEqual({
      ok: false,
      error: 'args.token must be a token the market lists on this network',
    });
    expect(
      buildBalanceAction('deposit', { token: 'USDC', amount: '0' }, balance()),
    ).toMatchObject({ ok: false });
    expect(
      buildBalanceAction(
        'deposit',
        { token: 'USDC', amount: '1.5' },
        balance(),
      ),
    ).toMatchObject({ ok: false });
  });

  it('grants operator bits by number or by name, never to the account itself', () => {
    expect(permissionBits(['release', 'trade'])).toBe(6);
    expect(permissionBits(15)).toBe(15);
    expect(permissionBits(16)).toBeNull();
    expect(permissionBits(['everything'])).toBeNull();
    expect(
      buildBalanceAction(
        'setOperator',
        { operator: BOT, permissions: ['release'] },
        balance(),
      ),
    ).toMatchObject({
      ok: true,
      value: { data: p2pCalldata.setOperator(BOT, 2) },
    });
    expect(
      buildBalanceAction(
        'setOperator',
        { operator: ACCOUNT, permissions: 1 },
        balance(),
      ),
    ).toMatchObject({ ok: false });
  });

  it('authorises only our matcher, and refuses autoSettle to a liquidity merchant', () => {
    expect(
      buildBalanceAction('setMatcher', { maxPerOrder: '500000000' }, balance()),
    ).toMatchObject({
      ok: true,
      value: { data: p2pCalldata.setMatcher(MATCHER, 500_000_000n, false) },
    });
    expect(
      buildBalanceAction(
        'setMatcher',
        { maxPerOrder: '500000000', autoSettle: true },
        balance({ sellsLiquidity: true }),
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('autoSettle'),
    });
    expect(
      buildBalanceAction('setMatcher', { maxPerOrder: '0' }, balance()),
    ).toMatchObject({
      ok: true,
      value: { description: expect.stringContaining('Revoke') },
    });
    expect(
      buildBalanceAction(
        'setMatcher',
        { maxPerOrder: '1' },
        balance({ matcher: null }),
      ),
    ).toMatchObject({ ok: false });
  });

  it('lets only the seller release, only the buyer mark paid', () => {
    expect(buildOrderAction('release', orderCtx(ACCOUNT))).toMatchObject({
      ok: true,
      value: {
        data: p2pCalldata.orderAction('release', 7n),
        description: 'Release order 7: pays its buyer 99.5 USDC',
      },
    });
    expect(buildOrderAction('release', orderCtx(BUYER))).toEqual({
      ok: false,
      error: 'only the order’s seller releases it',
    });
    expect(buildOrderAction('markPaid', orderCtx(BUYER))).toMatchObject({
      ok: true,
    });
    expect(buildOrderAction('markPaid', orderCtx(ACCOUNT))).toMatchObject({
      ok: false,
    });
  });

  it('follows the contract’s cancel rules', () => {
    expect(buildOrderAction('cancel', orderCtx(BUYER))).toMatchObject({
      ok: true,
    });
    expect(buildOrderAction('cancel', orderCtx(ACCOUNT))).toMatchObject({
      ok: false,
    });
    expect(
      buildOrderAction(
        'cancel',
        orderCtx(ACCOUNT, { paymentDeadline: new Date(NOW.getTime() - 1) }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      buildOrderAction('cancel', orderCtx(ACCOUNT, { status: 'paid' })),
    ).toMatchObject({ ok: false });
    expect(buildOrderAction('cancel', orderCtx(BOT))).toMatchObject({
      ok: false,
    });
  });

  it('accepts and disputes only from the right status, and never before the order is open', () => {
    expect(
      buildOrderAction(
        'accept',
        orderCtx(BUYER, { status: 'awaiting_acceptance' }),
      ),
    ).toMatchObject({ ok: true });
    expect(buildOrderAction('accept', orderCtx(BUYER))).toMatchObject({
      ok: false,
    });
    expect(
      buildOrderAction('dispute', orderCtx(ACCOUNT, { status: 'paid' })),
    ).toMatchObject({ ok: true });
    expect(
      buildOrderAction('release', orderCtx(ACCOUNT, { onchainId: null })),
    ).toEqual({ ok: false, error: 'the order is not open on-chain yet' });
  });
});
