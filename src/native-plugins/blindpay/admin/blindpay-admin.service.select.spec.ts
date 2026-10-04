import { AdminExtensions } from '@/admin/admin-extensions';
import {
  BlindpayAdminService,
  PAYIN_ADMIN_SELECT,
  PAYOUT_ADMIN_SELECT,
  RECEIVER_ADMIN_SELECT,
} from '@/native-plugins/blindpay/admin/blindpay-admin.service';
import {
  PAYIN_PUBLIC_SELECT,
  PAYOUT_PUBLIC_SELECT,
} from '@/native-plugins/blindpay/blindpay-sync.service';
import { RECEIVER_PUBLIC_SELECT } from '@/native-plugins/blindpay/kyc/receivers/receivers.service';

/**
 * The admin lists read through an allowlist `select`, never an `omit` list, so a
 * column added to these tables later stays in PostgreSQL until someone names it.
 * The key lists below are the admin response the console renders today; a
 * change to one is a change to that contract and should be made on purpose.
 */
const CONSUMER = { select: { apisixUsername: true, credentialId: true } };

function makeService() {
  const findMany = jest.fn(async (_args: unknown) => []);
  const count = jest.fn(async () => 0);
  const prisma: any = {
    blindpayReceiver: { findMany, count },
    payin: { findMany, count },
    payout: { findMany, count },
  };
  const service = new BlindpayAdminService(
    prisma,
    {} as any,
    new AdminExtensions(),
  );
  return { service, findMany };
}

describe('BlindpayAdminService list projections', () => {
  it.each([
    ['receivers', RECEIVER_ADMIN_SELECT],
    ['payins', PAYIN_ADMIN_SELECT],
    ['payouts', PAYOUT_ADMIN_SELECT],
  ] as const)(
    '%s reads through its admin select, with no include or omit',
    async (method, select) => {
      const { service, findMany } = makeService();
      await service[method]({ consumer: 'c1', take: 5, skip: 10 });
      expect(findMany).toHaveBeenCalledWith({
        where: { consumerId: 'c1' },
        take: 5,
        skip: 10,
        orderBy: { createdAt: 'desc' },
        select,
      });
      const args = findMany.mock.calls[0][0] as object;
      expect(args).not.toHaveProperty('include');
      expect(args).not.toHaveProperty('omit');
    },
  );

  it.each([
    ['receiver', RECEIVER_ADMIN_SELECT],
    ['payin', PAYIN_ADMIN_SELECT],
    ['payout', PAYOUT_ADMIN_SELECT],
  ] as const)('never selects raw for a %s', (_name, select) => {
    expect(select).not.toHaveProperty('raw');
    // Every scalar entry is an explicit `true`; the only relation is the
    // owning consumer's two attribution fields.
    for (const value of Object.values(select)) {
      expect([true, CONSUMER]).toContainEqual(value);
    }
  });

  it('never selects the funding instructions of a payin', () => {
    expect(PAYIN_ADMIN_SELECT).not.toHaveProperty('instructions');
  });

  it('keeps the admin response the console renders', () => {
    expect(Object.keys(RECEIVER_ADMIN_SELECT).sort()).toEqual(
      [
        ...Object.keys(RECEIVER_PUBLIC_SELECT),
        'consumerId',
        'environment',
        'reference',
        'tosSentAt',
        'consumer',
      ].sort(),
    );
    expect(Object.keys(PAYIN_ADMIN_SELECT).sort()).toEqual(
      [
        ...Object.keys(PAYIN_PUBLIC_SELECT).filter((k) => k !== 'instructions'),
        'consumerId',
        'receiverId',
        'environment',
        'quoteId',
        'currency',
        'updatedAt',
        'consumer',
      ].sort(),
    );
    expect(Object.keys(PAYOUT_ADMIN_SELECT).sort()).toEqual(
      [
        ...Object.keys(PAYOUT_PUBLIC_SELECT),
        'consumerId',
        'receiverId',
        'environment',
        'quoteId',
        'bankAccountId',
        'updatedAt',
        'consumer',
      ].sort(),
    );
  });
});
