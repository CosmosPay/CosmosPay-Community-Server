import { Reflector } from '@nestjs/core';
import { BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT } from '@/blindpay/blindpay.constants';
import { RATE_LIMIT_KEY } from '@/common/decorators/rate-limit.decorator';
import { KYC_TOS_RATE_LIMIT, KYC_UPLOAD_RATE_LIMIT } from '@/kyc/kyc.constants';
import { KycMetaController } from '@/kyc/upload/kyc-meta.controller';
import { OfframpController } from '@/offramp/offramp.controller';
import {
  OFFRAMP_DOCUMENT_RATE_LIMIT,
  OFFRAMP_PAYOUT_RATE_LIMIT,
  OFFRAMP_QUOTE_RATE_LIMIT,
} from '@/offramp/offramp.constants';
import { OnrampController } from '@/onramp/onramp.controller';
import {
  ONRAMP_PAYIN_RATE_LIMIT,
  ONRAMP_QUOTE_RATE_LIMIT,
  ONRAMP_TRUSTLINE_RATE_LIMIT,
} from '@/onramp/onramp.constants';

const policiesOf = (handler: (...args: any[]) => unknown) =>
  new Reflector().get(RATE_LIMIT_KEY, handler) ?? [];

const kyc = KycMetaController.prototype;
const onramp = OnrampController.prototype;
const offramp = OfframpController.prototype;

describe('BlindPay-backed routes declare a budget', () => {
  it('counts every route that reaches BlindPay against the per-consumer quota', () => {
    // One BlindPay instance serves every tenant on the key, so the provider's
    // quota is shared the way Pollar's is: a tenant looping quotes fails other
    // tenants' payins. A per-address budget cannot say that — the tenant picks
    // how many addresses it calls from.
    for (const handler of [
      kyc.upload,
      kyc.initiateTos,
      onramp.createQuote,
      onramp.createPayin,
      offramp.createQuote,
      offramp.authorize,
      offramp.createPayout,
      offramp.addDocument,
    ]) {
      expect(policiesOf(handler)).toContain(BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT);
    }
  });

  it('caps each write the provider keeps, per address', () => {
    // These all leave something behind that no error response takes back: a
    // stored file, a terms-of-service record, a payin with bank instructions,
    // a payout, an attached document.
    expect(policiesOf(kyc.upload)).toContain(KYC_UPLOAD_RATE_LIMIT);
    expect(policiesOf(kyc.initiateTos)).toContain(KYC_TOS_RATE_LIMIT);
    expect(policiesOf(onramp.createQuote)).toContain(ONRAMP_QUOTE_RATE_LIMIT);
    expect(policiesOf(onramp.createPayin)).toContain(ONRAMP_PAYIN_RATE_LIMIT);
    expect(policiesOf(offramp.createQuote)).toContain(OFFRAMP_QUOTE_RATE_LIMIT);
    expect(policiesOf(offramp.addDocument)).toContain(
      OFFRAMP_DOCUMENT_RATE_LIMIT,
    );
  });

  it('gives authorize and the payout it prepares one shared bucket', () => {
    // The same policy object on both, not two equal ones: separate buckets
    // would let a loop alternate the routes and take both budgets.
    expect(policiesOf(offramp.authorize)).toContain(OFFRAMP_PAYOUT_RATE_LIMIT);
    expect(policiesOf(offramp.createPayout)).toContain(
      OFFRAMP_PAYOUT_RATE_LIMIT,
    );
  });

  it('caps the trustline build, which spends the shared Horizon budget', () => {
    // Not a BlindPay call, so no provider ceiling — what it spends is the
    // per-IP Horizon budget every route in this service shares.
    expect(policiesOf(onramp.createTrustline)).toContain(
      ONRAMP_TRUSTLINE_RATE_LIMIT,
    );
    expect(policiesOf(onramp.createTrustline)).not.toContain(
      BLINDPAY_CONSUMER_QUOTA_RATE_LIMIT,
    );
  });

  it('leaves reads unlimited', () => {
    // The budgets exist for cost an error cannot refund. A list or a read costs
    // a query, and APISIX is what shapes ordinary traffic.
    for (const handler of [
      onramp.findAll,
      onramp.findOne,
      offramp.findAll,
      offramp.findOne,
    ]) {
      expect(policiesOf(handler)).toEqual([]);
    }
  });
});
