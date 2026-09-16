import { Reflector } from '@nestjs/core';
import { RATE_LIMIT_KEY } from '@/common/decorators/rate-limit.decorator';
import { LiquidityPoolsController } from '@/liquidity-pools/liquidity-pools.controller';
import {
  LIQUIDITY_BUILD_RATE_LIMIT,
  LIQUIDITY_SUBMIT_RATE_LIMIT,
} from '@/liquidity-pools/liquidity-pools.constants';
import { PAYMENT_INTENT_BUILD_RATE_LIMIT } from '@/payment-intents/payment-intents.constants';
import { PaymentIntentsController } from '@/payment-intents/payment-intents.controller';
import { SwapsController } from '@/swaps/swaps.controller';
import {
  SWAP_CREATE_RATE_LIMIT,
  SWAP_QUOTE_RATE_LIMIT,
  SWAP_SUBMIT_RATE_LIMIT,
} from '@/swaps/swaps.constants';

const policiesOf = (handler: (...args: any[]) => unknown) =>
  new Reflector().get(RATE_LIMIT_KEY, handler) ?? [];

const intents = PaymentIntentsController.prototype;
const swaps = SwapsController.prototype;
const pools = LiquidityPoolsController.prototype;

/**
 * The routes that build a Stellar transaction all take the shared public API
 * key, under which every anonymous wallet is one consumer. Only the submit
 * routes were capped, so a loop on a builder could take the per-IP Horizon
 * budget that swaps, pools and payment intents all share, and degrade the three
 * of them for every anonymous caller at once.
 */
describe('transaction builders declare a budget', () => {
  it('caps both payment-intent builders from one bucket', () => {
    // Two spellings of one step, so one budget: separate buckets would only let
    // a loop alternate `tx` and `pay` and take both.
    expect(policiesOf(intents.createTx)).toContain(
      PAYMENT_INTENT_BUILD_RATE_LIMIT,
    );
    expect(policiesOf(intents.createPay)).toContain(
      PAYMENT_INTENT_BUILD_RATE_LIMIT,
    );
  });

  it('caps the swap quote and the swap build apart from the submit', () => {
    // A quote persists nothing and still costs a strict-send path search, the
    // most expensive call this service makes of Horizon.
    expect(policiesOf(swaps.quote)).toContain(SWAP_QUOTE_RATE_LIMIT);
    expect(policiesOf(swaps.create)).toContain(SWAP_CREATE_RATE_LIMIT);
    expect(policiesOf(swaps.submit)).toContain(SWAP_SUBMIT_RATE_LIMIT);
    expect(policiesOf(swaps.quote)).not.toContain(SWAP_SUBMIT_RATE_LIMIT);
  });

  it('gives deposit and withdraw one shared build bucket', () => {
    expect(policiesOf(pools.deposit)).toContain(LIQUIDITY_BUILD_RATE_LIMIT);
    expect(policiesOf(pools.withdraw)).toContain(LIQUIDITY_BUILD_RATE_LIMIT);
    expect(policiesOf(pools.submit)).toContain(LIQUIDITY_SUBMIT_RATE_LIMIT);
  });

  it('leaves reads unlimited', () => {
    for (const handler of [
      intents.findAll,
      intents.findOne,
      swaps.findAll,
      swaps.findOne,
      pools.listPools,
      pools.positions,
    ]) {
      expect(policiesOf(handler)).toEqual([]);
    }
  });
});
