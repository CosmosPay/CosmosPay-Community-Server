import type { PaymentIntent } from '@generated/prisma/client';
import { SETTLEMENT_RIVAL_FILTERS } from '@/payment-intents/settlement-rivals';

const DEST = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const USDC = '0x3600000000000000000000000000000000000000';

const intent = (over: Partial<PaymentIntent>) =>
  ({
    id: 'pi_1',
    destination: DEST,
    assetIssuer: USDC,
    chainReference: null,
    ...over,
  }) as PaymentIntent;

describe('SETTLEMENT_RIVAL_FILTERS on Arc', () => {
  it('ranks a direct intent only against deposit addresses at its payee, as on Monad', () => {
    for (const chain of ['arc', 'monad'] as const) {
      expect(SETTLEMENT_RIVAL_FILTERS[chain](intent({}))).toEqual({
        chainReference: DEST,
        assetIssuer: USDC,
      });
    }
  });

  it('gives an intent with its own deposit address no rivals', () => {
    const withDeposit = intent({
      chainReference: '0xC830d264C14ebDB31cdEa0Fb6f83C5b0D8EEc52F',
    });
    expect(SETTLEMENT_RIVAL_FILTERS.arc(withDeposit)).toEqual(
      SETTLEMENT_RIVAL_FILTERS.monad(withDeposit),
    );
  });
});
