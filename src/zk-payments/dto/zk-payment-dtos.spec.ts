import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ConfirmZkPaymentDto } from '@/zk-payments/dto/confirm-zk-payment.dto';
import { CreateZkPaymentDto } from '@/zk-payments/dto/create-zk-payment.dto';
import { QueryZkPaymentsDto } from '@/zk-payments/dto/query-zk-payments.dto';
import { ZkCheckoutConfigQueryDto } from '@/zk-payments/dto/zk-checkout-config-query.dto';

const MERCHANT = 'GCALNQQBXAPZ2WIRSDDBMSTAKCUH5SG6U76YBFLQLIXJTF7FE5AX7AOO';

async function failures(cls: new () => object, plain: object) {
  const errors = await validate(plainToInstance(cls, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe('CreateZkPaymentDto', () => {
  it('accepts a minimal request', async () => {
    expect(
      await failures(CreateZkPaymentDto, {
        amount: '25.5',
        recipient: MERCHANT,
      }),
    ).toEqual([]);
  });

  it('accepts every optional field within bounds', async () => {
    expect(
      await failures(CreateZkPaymentDto, {
        amount: '0.0000002',
        recipient: MERCHANT,
        description: 'Order #24',
        expiresInMinutes: '10080',
        idempotencyKey: 'order-24',
      }),
    ).toEqual([]);
  });

  it.each([
    ['an amount with 8 decimal places', { amount: '1.00000001' }, 'amount'],
    ['a negative amount', { amount: '-1' }, 'amount'],
    ['a numeric amount', { amount: 25 }, 'amount'],
    [
      'a contract as recipient',
      { recipient: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526' },
      'recipient',
    ],
    ['a malformed recipient', { recipient: 'GABC' }, 'recipient'],
    ['a lifetime of zero', { expiresInMinutes: 0 }, 'expiresInMinutes'],
    [
      'a lifetime over seven days',
      { expiresInMinutes: 10081 },
      'expiresInMinutes',
    ],
    ['a fractional lifetime', { expiresInMinutes: 1.5 }, 'expiresInMinutes'],
    ['an empty description', { description: '' }, 'description'],
    [
      'a description over 280 characters',
      { description: 'x'.repeat(281) },
      'description',
    ],
    [
      'an idempotency key over 255 characters',
      { idempotencyKey: 'k'.repeat(256) },
      'idempotencyKey',
    ],
  ])('refuses %s', async (_label, over, property) => {
    expect(
      await failures(CreateZkPaymentDto, {
        amount: '25',
        recipient: MERCHANT,
        ...over,
      }),
    ).toContain(property);
  });

  it('refuses a field it does not know (no network override)', async () => {
    expect(
      await failures(CreateZkPaymentDto, {
        amount: '25',
        recipient: MERCHANT,
        network: 'public',
      }),
    ).toContain('network');
  });
});

describe('ConfirmZkPaymentDto', () => {
  it('accepts two transaction hashes, in either case', async () => {
    expect(
      await failures(ConfirmZkPaymentDto, {
        paymentTxHash: 'A'.repeat(64),
        feeTxHash: 'b'.repeat(64),
      }),
    ).toEqual([]);
  });

  it.each([
    ['a short hash', { paymentTxHash: 'a'.repeat(63) }, 'paymentTxHash'],
    ['a 0x-prefixed hash', { feeTxHash: `0x${'b'.repeat(64)}` }, 'feeTxHash'],
    ['a missing fee hash', { feeTxHash: undefined }, 'feeTxHash'],
  ])('refuses %s', async (_label, over, property) => {
    expect(
      await failures(ConfirmZkPaymentDto, {
        paymentTxHash: 'a'.repeat(64),
        feeTxHash: 'b'.repeat(64),
        ...over,
      }),
    ).toContain(property);
  });
});

describe('QueryZkPaymentsDto', () => {
  it('takes a status and the shared pagination', async () => {
    expect(
      await failures(QueryZkPaymentsDto, {
        status: 'EXPIRED',
        take: '50',
        skip: '0',
      }),
    ).toEqual([]);
  });

  it('refuses an unknown status and an oversized page', async () => {
    const errors = await failures(QueryZkPaymentsDto, {
      status: 'FAILED',
      take: '101',
    });
    expect(errors).toEqual(expect.arrayContaining(['status', 'take']));
  });
});

describe('ZkCheckoutConfigQueryDto', () => {
  it('takes testnet or public', async () => {
    expect(
      await failures(ZkCheckoutConfigQueryDto, { network: 'testnet' }),
    ).toEqual([]);
    expect(
      await failures(ZkCheckoutConfigQueryDto, { network: 'public' }),
    ).toEqual([]);
  });

  it('requires the network and refuses any other', async () => {
    expect(await failures(ZkCheckoutConfigQueryDto, {})).toContain('network');
    expect(
      await failures(ZkCheckoutConfigQueryDto, { network: 'mainnet' }),
    ).toContain('network');
  });
});
