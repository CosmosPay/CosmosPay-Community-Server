import { DETERMINISTIC_DEPLOYER } from '@/evm/evm.constants';
import {
  depositAddress,
  FLUSH_CALLDATA,
  flushTokenCalldata,
  forwarderInitCode,
} from '@/evm/payment-forwarder';
import { EvmDepositForwarderService } from '@/payment-intents/evm-deposit-forwarder.service';

const DEST = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const RELAYER = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const SALT = `0x${'11'.repeat(32)}`;
const TOKEN = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const HASH = `0x${'ab'.repeat(32)}`;
const ONE = 10n ** 18n;
const FEE = 10n ** 16n;
/** The real CREATE2 address of these terms, as the forwarder recomputes it. */
const ADDRESS = depositAddress(
  SALT,
  forwarderInitCode({
    destination: DEST,
    token: null,
    relayer: RELAYER,
    fee: FEE,
  }),
);

function intent(over: Record<string, unknown> = {}) {
  return {
    id: 'pi_1',
    status: 'PENDING',
    amount: '1',
    assetIssuer: null,
    assetDecimals: null,
    expiresAt: new Date(Date.now() + 60_000),
    consumer: { apisixUsername: 'cosmos_u1' },
    ...over,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'dep_1',
    intentId: 'pi_1',
    chain: 'monad',
    network: 'public',
    address: ADDRESS,
    salt: SALT,
    destination: DEST,
    token: null,
    relayer: RELAYER,
    fee: FEE.toString(),
    status: 'AWAITING',
    forwardTxHash: null,
    forwardedAmount: null,
    forwardSentAt: null,
    intent: intent(),
    ...over,
  } as never;
}

function make(opts: {
  balance?: bigint;
  hasCode?: boolean;
  receipt?: unknown;
}) {
  const rpc = {
    getBalance: jest.fn().mockResolvedValue(opts.balance ?? 0n),
    erc20BalanceOf: jest.fn().mockResolvedValue(opts.balance ?? 0n),
    hasCode: jest.fn().mockResolvedValue(opts.hasCode ?? false),
    getReceipt: jest.fn().mockResolvedValue(opts.receipt ?? null),
  };
  const relayer = {
    isEnabled: () => true,
    send: jest.fn().mockResolvedValue(HASH),
  };
  const prisma = {
    evmDepositAddress: { update: jest.fn(), findMany: jest.fn() },
  };
  const paymentIntents = { markSucceeded: jest.fn() };
  const service = new EvmDepositForwarderService(
    { get: () => ({ enabled: true, intervalMs: 1000 }) } as never,
    prisma as never,
    rpc as never,
    relayer as never,
    paymentIntents as never,
    {} as never,
  );
  return { service, rpc, relayer, prisma, paymentIntents };
}

describe('EvmDepositForwarderService — forwarding', () => {
  it('waits while the deposit is short of the intent', async () => {
    const { service, relayer } = make({ balance: ONE / 2n });
    await service.forwardIfFunded(row());
    expect(relayer.send).not.toHaveBeenCalled();
  });

  it('deploys the forwarder through the proxy once the deposit covers the intent', async () => {
    const { service, relayer, prisma } = make({ balance: ONE });
    await service.forwardIfFunded(row());
    const [, , call] = relayer.send.mock.calls[0];
    expect(call.to).toBe(DETERMINISTIC_DEPLOYER);
    expect(call.data.startsWith(`0x${'11'.repeat(32)}`)).toBe(true);
    expect(prisma.evmDepositAddress.update).toHaveBeenCalledWith({
      where: { id: 'dep_1' },
      data: expect.objectContaining({
        status: 'FORWARDING',
        forwardTxHash: HASH,
        forwardedAmount: ONE.toString(),
      }),
    });
  });

  it('refuses to deploy an address the current bytecode does not produce', async () => {
    const { service, relayer } = make({ balance: ONE });
    // Terms altered after minting — as if the artifact had changed.
    await service.forwardIfFunded(row({ fee: (FEE + 1n).toString() }));
    expect(relayer.send).not.toHaveBeenCalled();
  });

  it('flushes instead when the forwarder is already deployed', async () => {
    let { service, relayer } = make({ balance: ONE, hasCode: true });
    await service.forwardIfFunded(row());
    expect(relayer.send.mock.calls[0][2]).toEqual({
      to: ADDRESS,
      data: FLUSH_CALLDATA,
    });

    ({ service, relayer } = make({ balance: 5n, hasCode: true }));
    await service.forwardIfFunded(row({ token: TOKEN, status: 'FORWARDED' }));
    expect(relayer.send.mock.calls[0][2]).toEqual({
      to: ADDRESS,
      data: flushTokenCalldata(TOKEN),
    });
  });

  it('forwards a partial payment once the intent has lapsed — it is the merchant’s money', async () => {
    const { service, relayer } = make({ balance: ONE / 2n });
    await service.forwardIfFunded(
      row({ intent: intent({ status: 'EXPIRED', expiresAt: new Date(0) }) }),
    );
    expect(relayer.send).toHaveBeenCalled();
  });

  it('never deploys for a balance the fee would swallow', async () => {
    const { service, relayer } = make({ balance: FEE });
    await service.forwardIfFunded(
      row({ intent: intent({ status: 'EXPIRED', expiresAt: new Date(0) }) }),
    );
    expect(relayer.send).not.toHaveBeenCalled();
  });

  it('forwards an open-amount deposit as soon as it clears the fee', async () => {
    const { service, relayer } = make({ balance: FEE + 1n });
    await service.forwardIfFunded(row({ intent: intent({ amount: null }) }));
    expect(relayer.send).toHaveBeenCalled();
  });
});

describe('EvmDepositForwarderService — confirming', () => {
  const inFlight = (over: Record<string, unknown> = {}) =>
    row({
      status: 'FORWARDING',
      forwardTxHash: HASH,
      forwardedAmount: ONE.toString(),
      forwardSentAt: new Date(),
      ...over,
    });

  it('settles the intent on the confirmed forward', async () => {
    const { service, paymentIntents, prisma } = make({
      receipt: { status: '0x1' },
    });
    await service.confirm(inFlight());
    expect(prisma.evmDepositAddress.update.mock.calls[0][0].data.status).toBe(
      'FORWARDED',
    );
    expect(paymentIntents.markSucceeded).toHaveBeenCalledWith(
      'pi_1',
      'cosmos_u1',
      HASH,
      undefined,
      'observer',
    );
  });

  it('settles an EXPIRED intent too, but not one already paid, cancelled or short', async () => {
    let { service, paymentIntents } = make({ receipt: { status: '0x1' } });
    await service.confirm(inFlight({ intent: intent({ status: 'EXPIRED' }) }));
    expect(paymentIntents.markSucceeded).toHaveBeenCalled();

    for (const over of [
      { intent: intent({ status: 'SUCCEEDED' }) },
      { intent: intent({ status: 'CANCELLED' }) },
      { forwardedAmount: (ONE / 2n).toString() },
    ]) {
      ({ service, paymentIntents } = make({ receipt: { status: '0x1' } }));
      await service.confirm(inFlight(over));
      expect(paymentIntents.markSucceeded).not.toHaveBeenCalled();
    }
  });

  it('goes back to AWAITING on a revert, and on a receipt that never came', async () => {
    let { service, prisma } = make({ receipt: { status: '0x0' } });
    await service.confirm(inFlight());
    expect(prisma.evmDepositAddress.update.mock.calls[0][0].data).toEqual({
      status: 'AWAITING',
    });

    ({ service, prisma } = make({ receipt: null }));
    await service.confirm(inFlight({ forwardSentAt: new Date(0) }));
    expect(prisma.evmDepositAddress.update.mock.calls[0][0].data).toEqual({
      status: 'AWAITING',
    });
  });

  it('keeps waiting for a recent forward with no receipt yet', async () => {
    const { service, prisma } = make({ receipt: null });
    await service.confirm(inFlight());
    expect(prisma.evmDepositAddress.update).not.toHaveBeenCalled();
  });
});
