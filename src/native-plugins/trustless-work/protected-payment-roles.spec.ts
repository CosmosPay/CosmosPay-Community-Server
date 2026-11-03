import { Keypair } from '@stellar/stellar-sdk';
import {
  approvesUnder,
  contractRoles,
  DEADLINE_POLICY_BENEFICIARY,
  holdsRole,
  releasesUnder,
  resolvesAutomatically,
} from '@/native-plugins/trustless-work/protected-payment-roles';

const accounts = {
  buyer: Keypair.random().publicKey(),
  merchant: Keypair.random().publicKey(),
  platform: Keypair.random().publicKey(),
  disputeResolver: Keypair.random().publicKey(),
};
const { buyer, merchant, platform, disputeResolver } = accounts;

describe('contractRoles', () => {
  // The product owner's table (2026-11-02), row by row.
  it.each([
    ['BUYER_RELEASES', buyer, buyer],
    ['MERCHANT_RELEASES', merchant, merchant],
    ['BUYER_APPROVES_MERCHANT_RELEASES', buyer, merchant],
  ] as const)(
    '%s: approver and release signer',
    (model, approver, releaseSigner) => {
      expect(contractRoles(model, accounts)).toEqual({
        approver,
        serviceProvider: merchant,
        platform,
        releaseSigner,
        disputeResolver,
        receiver: merchant,
      });
    },
  );
});

describe('who may do what', () => {
  it('lets each party approve and release only where the model says', () => {
    expect(approvesUnder('BUYER_RELEASES', 'BUYER')).toBe(true);
    expect(releasesUnder('BUYER_RELEASES', 'BUYER')).toBe(true);
    expect(approvesUnder('BUYER_RELEASES', 'MERCHANT')).toBe(false);
    expect(approvesUnder('MERCHANT_RELEASES', 'BUYER')).toBe(false);
    expect(releasesUnder('MERCHANT_RELEASES', 'MERCHANT')).toBe(true);
    expect(approvesUnder('BUYER_APPROVES_MERCHANT_RELEASES', 'BUYER')).toBe(
      true,
    );
    expect(releasesUnder('BUYER_APPROVES_MERCHANT_RELEASES', 'BUYER')).toBe(
      false,
    );
    expect(releasesUnder('BUYER_APPROVES_MERCHANT_RELEASES', 'MERCHANT')).toBe(
      true,
    );
  });

  it('gives the buyer no role under MERCHANT_RELEASES, so the platform opens its dispute', () => {
    expect(holdsRole('MERCHANT_RELEASES', 'BUYER')).toBe(false);
    expect(holdsRole('BUYER_RELEASES', 'BUYER')).toBe(true);
    expect(holdsRole('BUYER_APPROVES_MERCHANT_RELEASES', 'BUYER')).toBe(true);
    for (const model of [
      'BUYER_RELEASES',
      'MERCHANT_RELEASES',
      'BUYER_APPROVES_MERCHANT_RELEASES',
    ] as const) {
      expect(holdsRole(model, 'MERCHANT')).toBe(true);
    }
  });

  it('settles the auto policies for one party and leaves manual review to ops', () => {
    expect(DEADLINE_POLICY_BENEFICIARY).toEqual({
      MANUAL_REVIEW: null,
      REFUND_BUYER: 'BUYER',
      RELEASE_MERCHANT: 'MERCHANT',
    });
    expect(resolvesAutomatically('MANUAL_REVIEW')).toBe(false);
    expect(resolvesAutomatically('REFUND_BUYER')).toBe(true);
  });
});
