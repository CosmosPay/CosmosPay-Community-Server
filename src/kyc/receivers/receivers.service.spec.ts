import { HttpStatus } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '../../common/errors/api-error';
import {
  RECEIVER_PUBLIC_SELECT,
  ReceiversService,
  isElevatedConsumer,
  resolveTosCooldownMs,
} from './receivers.service';
import { ALLOWED_TRANSITIONS, assertTransition } from './receiver-state';

/** An ordinary tenant key: `kyc:write`, no elevation. */
const CONSUMER = {
  username: 'cosmos_u1',
  credentialId: 'cosmos_cred_1',
  role: 'user',
  permissions: ['kyc:read', 'kyc:write'],
  organizationId: 'org_1',
} as any;
/** Same tenant, but an `admin`-role key (X-Consumer-Role: admin). */
const ADMIN_CONSUMER = { ...CONSUMER, role: 'admin' };
const LOCAL_ID = 'local_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const REAL_ID = 're_000000000000';

function baseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rcv_1',
    consumerId: 'c1',
    blindpayId: LOCAL_ID,
    type: 'individual',
    kycType: 'standard',
    kycStatus: 'inactive',
    email: 'jane@acme.com',
    name: null,
    country: 'US',
    externalId: null,
    disabled: false,
    tosSentAt: null,
    raw: {
      type: 'individual',
      kyc_type: 'standard',
      email: 'jane@acme.com',
      country: 'US',
      tax_id: '123-45-6789',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/** What the DB hands back under RECEIVER_PUBLIC_SELECT — no `raw`. */
function publicRow(overrides: Record<string, unknown> = {}) {
  const row = baseRow(overrides) as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(RECEIVER_PUBLIC_SELECT).map((k) => [k, row[k]]),
  );
}

function makeService() {
  const auditRows: any[] = [];
  const prisma: any = {
    blindpayReceiver: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    adminAuditLog: {
      create: jest.fn(async ({ data }: any) => {
        auditRows.push(data);
        return { id: 'aud_1', ...data };
      }),
    },
    consumer: {
      findUnique: jest.fn().mockResolvedValue({
        apisixUsername: 'cosmos_u1',
      }),
    },
    $transaction: jest.fn(async (fn: any) => {
      if (typeof fn === 'function') {
        return fn(prisma);
      }
      return Promise.all(fn);
    }),
  };
  const blindpay = {
    put: jest.fn(),
    post: jest.fn(),
    get: jest.fn(),
    delete: jest.fn(),
    instanceId: 'in_test',
    instancePath: jest.fn((p: string) => `/instances/in_test${p}`),
  };
  const consumers = {
    resolve: jest.fn().mockResolvedValue({ id: 'c1' }),
  };
  const sync = {
    mirrorReceiver: jest.fn(),
  };
  const config = {
    get: jest.fn().mockReturnValue({
      redirectUrlWhitelist: { cosmos_u1: ['app.example.com'] },
    }),
  };
  const service = new ReceiversService(
    prisma,
    blindpay as any,
    consumers as any,
    sync as any,
    config as any,
  );
  return { service, prisma, blindpay, consumers, sync, config, auditRows };
}

/** Awaits a rejection and returns it typed, so status/code can be asserted. */
async function rejection(p: Promise<unknown>): Promise<ApiError> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e as ApiError,
  );
}

describe('receiver-state assertTransition', () => {
  it('allows every declared edge in ALLOWED_TRANSITIONS', () => {
    for (const [from, tos] of Object.entries(ALLOWED_TRANSITIONS)) {
      for (const to of tos) {
        expect(() => assertTransition(from, to as any)).not.toThrow();
      }
    }
  });

  it('rejects inactive → pending_user with 409 naming both states', () => {
    let thrown: unknown;
    try {
      assertTransition('inactive', 'pending_user');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).getStatus()).toBe(HttpStatus.CONFLICT);
    // Not `idempotency_conflict`, which is what a bare ConflictException
    // defaulted to — an integrator could not tell a duplicate request from an
    // illegal KYC transition, the exact confusion ApiErrorCode ended.
    expect((thrown as ApiError).code).toBe(ApiErrorCode.KycStateInvalid);
    expect((thrown as ApiError).message).toBe(
      "Cannot move receiver from 'inactive' to 'pending_user'",
    );
  });

  it('allows pending_user → pending_review (re-review after post-approve edit)', () => {
    expect(() =>
      assertTransition('pending_user', 'pending_review'),
    ).not.toThrow();
  });

  it('rejects pending_user → inactive with 409', () => {
    expect(() => assertTransition('pending_user', 'inactive')).toThrow(
      ApiError,
    );
  });
});

describe('ReceiversService.update — local branch', () => {
  it('does not call BlindpayClient.put for a local_ blindpayId', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({ kycStatus: 'inactive' });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.update.mockImplementation(
      async ({ data }: any) => ({ ...row, ...data }),
    );

    await service.update(CONSUMER, row.id, { email: 'new@acme.com' });

    expect(blindpay.put).not.toHaveBeenCalled();
    expect(prisma.blindpayReceiver.update).toHaveBeenCalled();
  });

  it('promotes inactive → pending_review when the merged payload has KYC data', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({ kycStatus: 'inactive', raw: { type: 'individual' } });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.update.mockImplementation(
      async ({ data }: any) => ({ ...row, ...data }),
    );

    const result = await service.update(CONSUMER, row.id, {
      tax_id: '123-45-6789',
    });

    expect(blindpay.put).not.toHaveBeenCalled();
    expect(result.kycStatus).toBe('pending_review');
    expect(prisma.blindpayReceiver.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kycStatus: 'pending_review' }),
      }),
    );
  });

  it('keeps inactive when the patch does not satisfy hasKycData', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({ kycStatus: 'inactive', raw: { type: 'individual' } });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.update.mockImplementation(
      async ({ data }: any) => ({ ...row, ...data }),
    );

    const result = await service.update(CONSUMER, row.id, {
      email: 'only-email@acme.com',
    });

    expect(blindpay.put).not.toHaveBeenCalled();
    expect(result.kycStatus).toBe('inactive');
    expect(prisma.blindpayReceiver.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kycStatus: 'inactive' }),
      }),
    );
  });

  it('merges the patch onto raw and preserves untouched keys', async () => {
    const { service, prisma } = makeService();
    const row = baseRow({
      kycStatus: 'pending_review',
      raw: { type: 'individual', country: 'US' },
    });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    let savedRaw: Record<string, unknown> | undefined;
    prisma.blindpayReceiver.update.mockImplementation(async ({ data }: any) => {
      savedRaw = data.raw as Record<string, unknown>;
      return { ...row, ...data };
    });

    await service.update(CONSUMER, row.id, { tax_id: '99-9999999' });

    expect(savedRaw).toEqual({
      type: 'individual',
      country: 'US',
      tax_id: '99-9999999',
    });
  });

  it('strips tos_id from the local patch so it cannot be forged', async () => {
    const { service, prisma } = makeService();
    const row = baseRow({
      kycStatus: 'pending_user',
      raw: { type: 'individual', country: 'US', email: 'jane@acme.com' },
    });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    let savedRaw: Record<string, unknown> | undefined;
    let savedStatus: string | null | undefined;
    prisma.blindpayReceiver.update.mockImplementation(async ({ data }: any) => {
      savedRaw = data.raw as Record<string, unknown>;
      savedStatus = data.kycStatus;
      return { ...row, ...data };
    });

    await service.update(CONSUMER, row.id, {
      tax_id: '111',
      tos_id: 'tos_forged',
    });

    expect(savedRaw).not.toHaveProperty('tos_id');
    expect(savedRaw?.tax_id).toBe('111');
    // Post-approve KYC edit must re-enter the review gate.
    expect(savedStatus).toBe('pending_review');
  });

  it('demotes pending_user → pending_review when local KYC data is edited', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({
      kycStatus: 'pending_user',
      raw: {
        type: 'individual',
        country: 'US',
        email: 'jane@acme.com',
        tax_id: '123-45-6789',
      },
    });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.update.mockImplementation(
      async ({ data }: any) => ({ ...row, ...data }),
    );

    const result = await service.update(CONSUMER, row.id, {
      tax_id: '999-99-9999',
    });

    expect(blindpay.put).not.toHaveBeenCalled();
    expect(result.kycStatus).toBe('pending_review');
    expect(prisma.blindpayReceiver.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kycStatus: 'pending_review',
          raw: expect.objectContaining({ tax_id: '999-99-9999' }),
        }),
      }),
    );
  });
});

describe('ReceiversService.update — remote branch', () => {
  it('PUTs to BlindPay and mirrors when blindpayId is a real re_ id', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    const row = baseRow({
      blindpayId: REAL_ID,
      kycStatus: 'verifying',
    });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    blindpay.put.mockResolvedValue({ email: 'updated@acme.com' });
    sync.mirrorReceiver.mockResolvedValue({
      ...row,
      email: 'updated@acme.com',
    });
    prisma.blindpayReceiver.findUniqueOrThrow.mockResolvedValue(
      publicRow({ blindpayId: REAL_ID, email: 'updated@acme.com' }),
    );

    const result = await service.update(CONSUMER, row.id, {
      email: 'updated@acme.com',
      tos_id: 'tos_forged',
    });

    expect(blindpay.put).toHaveBeenCalledWith(
      '/instances/in_test/customers/re_000000000000',
      { email: 'updated@acme.com' },
    );
    expect(sync.mirrorReceiver).toHaveBeenCalledWith('c1', {
      id: REAL_ID,
      email: 'updated@acme.com',
    });
    expect(result.email).toBe('updated@acme.com');
    // The mirror hands back the whole row; the response is re-read narrowed.
    expect(result).not.toHaveProperty('raw');
  });
});

describe('ReceiversService — the KYC dossier never leaves the database', () => {
  it('RECEIVER_PUBLIC_SELECT is exactly the documented contract (no raw)', () => {
    expect(RECEIVER_PUBLIC_SELECT).not.toHaveProperty('raw');
    expect(Object.keys(RECEIVER_PUBLIC_SELECT).sort()).toEqual(
      [
        'blindpayId',
        'country',
        'createdAt',
        'disabled',
        'email',
        'externalId',
        'id',
        'kycStatus',
        'kycType',
        'name',
        'type',
        'updatedAt',
      ].sort(),
    );
  });

  it('findAll selects the public columns and never fetches raw', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayReceiver.findMany.mockResolvedValue([publicRow()]);
    prisma.blindpayReceiver.count.mockResolvedValue(3);

    const result = await service.findAll(CONSUMER, { take: 100, skip: 0 });

    expect(prisma.blindpayReceiver.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: RECEIVER_PUBLIC_SELECT }),
    );
    expect(result.data[0]).not.toHaveProperty('raw');
  });

  it('findAll reports the row count, not the page length', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayReceiver.findMany.mockResolvedValue([
      publicRow(),
      publicRow({ id: 'rcv_2' }),
    ]);
    prisma.blindpayReceiver.count.mockResolvedValue(57);

    const result = await service.findAll(CONSUMER, { take: 100, skip: 0 });

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(57);
    expect(prisma.blindpayReceiver.count).toHaveBeenCalledWith({
      where: { consumerId: 'c1' },
    });
  });

  it('findOne scopes to the consumer and selects the public columns', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayReceiver.findFirst.mockResolvedValue(publicRow());

    const result = await service.findOne(CONSUMER, 'rcv_1');

    expect(prisma.blindpayReceiver.findFirst).toHaveBeenCalledWith({
      where: { id: 'rcv_1', consumerId: 'c1' },
      select: RECEIVER_PUBLIC_SELECT,
    });
    expect(result).not.toHaveProperty('raw');
  });

  it('findOne re-reads narrowed after a BlindPay refresh instead of returning the mirror row', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    prisma.blindpayReceiver.findFirst.mockResolvedValue(
      publicRow({ blindpayId: REAL_ID, kycStatus: 'verifying' }),
    );
    blindpay.get.mockResolvedValue({ id: REAL_ID, kyc_status: 'approved' });
    // The sync service is shared with the admin surface: it returns the full row.
    sync.mirrorReceiver.mockResolvedValue(
      baseRow({ blindpayId: REAL_ID, kycStatus: 'approved' }),
    );
    prisma.blindpayReceiver.findUniqueOrThrow.mockResolvedValue(
      publicRow({ blindpayId: REAL_ID, kycStatus: 'approved' }),
    );

    const result = await service.findOne(CONSUMER, 'rcv_1');

    expect(result.kycStatus).toBe('approved');
    expect(result).not.toHaveProperty('raw');
  });

  it('create stores raw but does not echo it back', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayReceiver.create.mockResolvedValue(
      publicRow({ kycStatus: 'pending_review' }),
    );

    const result = await service.create(CONSUMER, {
      type: 'individual',
      kyc_type: 'standard',
      email: 'jane@acme.com',
      tax_id: '123-45-6789',
    } as any);

    const args = prisma.blindpayReceiver.create.mock.calls[0][0];
    expect(args.data.raw).toEqual(
      expect.objectContaining({ tax_id: '123-45-6789' }),
    );
    expect(args.select).toBe(RECEIVER_PUBLIC_SELECT);
    expect(result).not.toHaveProperty('raw');
  });
});

describe('ReceiversService.approve — the review gate needs a second party', () => {
  it('refuses a plain kyc:write key with 403 kyc_review_required', async () => {
    const { service, prisma, blindpay } = makeService();

    const err = await rejection(
      service.approve(CONSUMER, 'rcv_1', 'https://app.example.com/cb'),
    );

    expect(err).toBeInstanceOf(ApiError);
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(err.code).toBe(ApiErrorCode.KycReviewRequired);
    // Nothing happened: no lookup, and above all no terms email to the KYC subject.
    expect(prisma.blindpayReceiver.findFirst).not.toHaveBeenCalled();
    expect(blindpay.post).not.toHaveBeenCalled();
    expect(prisma.blindpayReceiver.updateMany).not.toHaveBeenCalled();
  });

  it('lets an admin-role key approve pending_review → pending_user', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({ kycStatus: 'pending_review' });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.findUnique.mockResolvedValue(row);
    blindpay.post.mockResolvedValue({ url: 'https://tos.example/accept' });
    prisma.blindpayReceiver.findUniqueOrThrow.mockResolvedValue(
      publicRow({ kycStatus: 'pending_user' }),
    );

    const result = await service.approve(
      ADMIN_CONSUMER,
      row.id,
      'https://app.example.com/cb',
    );

    expect(result.receiver.kycStatus).toBe('pending_user');
    expect(result.url).toBe('https://tos.example/accept');
    expect(result.receiver).not.toHaveProperty('raw');
  });

  it('isElevatedConsumer only accepts the gateway admin role', () => {
    expect(isElevatedConsumer(CONSUMER)).toBe(false);
    expect(isElevatedConsumer(ADMIN_CONSUMER)).toBe(true);
    expect(isElevatedConsumer({ ...CONSUMER, role: null })).toBe(false);
  });
});

describe('ReceiversService.approveById — transitions', () => {
  it('pending_review → pending_user succeeds', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({ kycStatus: 'pending_review' });
    prisma.blindpayReceiver.findUnique.mockResolvedValue(row);
    blindpay.post.mockResolvedValue({ url: 'https://tos.example/accept' });
    prisma.blindpayReceiver.findUniqueOrThrow.mockResolvedValue(
      publicRow({ kycStatus: 'pending_user' }),
    );

    const result = await service.approveById(
      row.id,
      'https://app.example.com/cb',
    );

    expect(result.receiver.kycStatus).toBe('pending_user');
    expect(result.url).toBe('https://tos.example/accept');
  });

  it('inactive → pending_user returns 409 naming both states', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayReceiver.findUnique.mockResolvedValue(
      baseRow({ kycStatus: 'inactive' }),
    );

    await expect(
      service.approveById('rcv_1', 'https://app.example.com/cb'),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      service.approveById('rcv_1', 'https://app.example.com/cb'),
    ).rejects.toThrow("Cannot move receiver from 'inactive' to 'pending_user'");
  });

  it('writes conditionally on the status it validated (compare-and-swap)', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({ kycStatus: 'pending_review' });
    prisma.blindpayReceiver.findUnique.mockResolvedValue(row);
    blindpay.post.mockResolvedValue({ url: 'https://tos.example/accept' });
    prisma.blindpayReceiver.findUniqueOrThrow.mockResolvedValue(
      publicRow({ kycStatus: 'pending_user' }),
    );

    await service.approveById(row.id, 'https://app.example.com/cb');

    expect(prisma.blindpayReceiver.updateMany).toHaveBeenCalledWith({
      where: { id: row.id, kycStatus: 'pending_review' },
      data: { kycStatus: 'pending_user', tosSentAt: expect.any(Date) },
    });
    // The unguarded `update({ where: { id } })` must not be used for transitions.
    expect(prisma.blindpayReceiver.update).not.toHaveBeenCalled();
  });

  it('409s when the receiver moved between the read and the write', async () => {
    const { service, prisma, blindpay } = makeService();
    prisma.blindpayReceiver.findUnique.mockResolvedValue(
      baseRow({ kycStatus: 'pending_review' }),
    );
    blindpay.post.mockResolvedValue({ url: 'https://tos.example/accept' });
    // A concurrent caller won the race: no row matches the old status any more.
    prisma.blindpayReceiver.updateMany.mockResolvedValue({ count: 0 });

    const err = await rejection(
      service.approveById('rcv_1', 'https://app.example.com/cb'),
    );

    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.code).toBe(ApiErrorCode.KycStateInvalid);
  });
});

describe('ReceiversService.enable — transitions', () => {
  it('pending_user → verifying (active) via enable succeeds', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    const row = baseRow({ kycStatus: 'pending_user' });
    prisma.blindpayReceiver.findUnique.mockResolvedValue(row);
    const created = {
      id: REAL_ID,
      kyc_status: 'verifying',
      type: 'individual',
      email: 'jane@acme.com',
    };
    blindpay.post.mockResolvedValue(created);
    sync.mirrorReceiver.mockResolvedValue({
      ...row,
      blindpayId: REAL_ID,
      kycStatus: 'verifying',
    });
    prisma.blindpayReceiver.findUniqueOrThrow.mockResolvedValue(
      publicRow({ blindpayId: REAL_ID, kycStatus: 'verifying' }),
    );

    const result = await service.enableById(row.id, 'tos_abc');

    expect(blindpay.post).toHaveBeenCalledWith(
      '/instances/in_test/customers',
      expect.objectContaining({ tos_id: 'tos_abc' }),
    );
    expect(sync.mirrorReceiver).toHaveBeenCalledWith('c1', created);
    expect(result.kycStatus).toBe('verifying');
    expect(result.blindpayId).toBe(REAL_ID);
    expect(result).not.toHaveProperty('raw');
  });

  it('inactive → verifying via enable returns 409', async () => {
    const { service, prisma, blindpay } = makeService();
    prisma.blindpayReceiver.findUnique.mockResolvedValue(
      baseRow({ kycStatus: 'inactive' }),
    );

    await expect(service.enableById('rcv_1', 'tos_abc')).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(service.enableById('rcv_1', 'tos_abc')).rejects.toThrow(
      "Cannot move receiver from 'inactive' to 'verifying'",
    );
    expect(blindpay.post).not.toHaveBeenCalled();
  });

  it('pending_review → verifying via enable returns 409', async () => {
    const { service, prisma, blindpay } = makeService();
    prisma.blindpayReceiver.findUnique.mockResolvedValue(
      baseRow({ kycStatus: 'pending_review' }),
    );

    await expect(service.enableById('rcv_1', 'tos_abc')).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(blindpay.post).not.toHaveBeenCalled();
  });
});

describe('ReceiversService.enableById — the upstream create is claimed first', () => {
  it('claims the transition BEFORE POSTing to BlindPay', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    const row = baseRow({ kycStatus: 'pending_user' });
    prisma.blindpayReceiver.findUnique.mockResolvedValue(row);
    blindpay.post.mockResolvedValue({ id: REAL_ID, kyc_status: 'verifying' });
    sync.mirrorReceiver.mockResolvedValue({ ...row, blindpayId: REAL_ID });
    prisma.blindpayReceiver.findUniqueOrThrow.mockResolvedValue(
      publicRow({ blindpayId: REAL_ID, kycStatus: 'verifying' }),
    );

    await service.enableById(row.id, 'tos_abc');

    expect(prisma.blindpayReceiver.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: row.id,
        kycStatus: 'pending_user',
        blindpayId: LOCAL_ID,
      },
      data: { kycStatus: 'verifying' },
    });
    expect(
      prisma.blindpayReceiver.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(blindpay.post.mock.invocationCallOrder[0]);
  });

  it('never creates a second upstream customer when two enables race', async () => {
    const { service, prisma, blindpay } = makeService();
    prisma.blindpayReceiver.findUnique.mockResolvedValue(
      baseRow({ kycStatus: 'pending_user' }),
    );
    // The other caller already claimed the row.
    prisma.blindpayReceiver.updateMany.mockResolvedValue({ count: 0 });

    const err = await rejection(service.enableById('rcv_1', 'tos_abc'));

    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.code).toBe(ApiErrorCode.KycStateInvalid);
    // The whole point: the loser must not create an orphan identity at the provider.
    expect(blindpay.post).not.toHaveBeenCalled();
  });

  it('releases the claim when the provider call fails, so the customer can retry', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({ kycStatus: 'pending_user' });
    prisma.blindpayReceiver.findUnique.mockResolvedValue(row);
    blindpay.post.mockRejectedValue(new Error('BlindPay 502'));

    await expect(service.enableById(row.id, 'tos_abc')).rejects.toThrow(
      'BlindPay 502',
    );

    expect(prisma.blindpayReceiver.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: row.id, kycStatus: 'verifying', blindpayId: LOCAL_ID },
      data: { kycStatus: 'pending_user' },
    });
  });

  it('guards the placeholder → real id write on the id it read', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    const row = baseRow({ kycStatus: 'pending_user' });
    prisma.blindpayReceiver.findUnique.mockResolvedValue(row);
    blindpay.post.mockResolvedValue({ id: REAL_ID });
    sync.mirrorReceiver.mockResolvedValue({ ...row, blindpayId: REAL_ID });
    prisma.blindpayReceiver.findUniqueOrThrow.mockResolvedValue(
      publicRow({ blindpayId: REAL_ID }),
    );

    await service.enableById(row.id, 'tos_abc');

    expect(prisma.blindpayReceiver.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: row.id, blindpayId: LOCAL_ID },
      data: { blindpayId: REAL_ID },
    });
    expect(prisma.blindpayReceiver.update).not.toHaveBeenCalled();
  });
});

describe('ReceiversService.requestTos — the resend cooldown is not header-driven', () => {
  const dto = {
    redirect_url: 'https://app.example.com/cb',
    channel: 'email',
  } as any;

  function pendingUser() {
    // Mailed a minute ago: inside the 24h default, outside a 0ms override.
    return baseRow({
      kycStatus: 'pending_user',
      tosSentAt: new Date(Date.now() - 60_000),
    });
  }

  it('ignores a cooldown override from an ordinary tenant key', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = pendingUser();
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.findUnique.mockResolvedValue(row);

    // The value a forged `X-Cosmos-Internal: 1` + `X-Cosmos-Tos-Cooldown-Ms: 0` yields.
    const err = await rejection(service.requestTos(CONSUMER, row.id, dto, 0));

    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.message).toMatch(/already sent/i);
    // No BlindPay call, so no second email to the KYC subject.
    expect(blindpay.post).not.toHaveBeenCalled();
  });

  it('honours the override for an elevated key', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = pendingUser();
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.findUnique.mockResolvedValue(row);
    blindpay.post.mockResolvedValue({ url: 'https://tos.example/accept' });

    const result = await service.requestTos(ADMIN_CONSUMER, row.id, dto, 0);

    expect(result.url).toBe('https://tos.example/accept');
    expect(result.channel).toBe('email');
  });

  it('re-asserts the cooldown in the UPDATE and 409s when a concurrent send won', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = pendingUser();
    prisma.blindpayReceiver.findUnique.mockResolvedValue(
      baseRow({ kycStatus: 'pending_user', tosSentAt: null }),
    );
    blindpay.post.mockResolvedValue({ url: 'https://tos.example/accept' });
    prisma.blindpayReceiver.updateMany.mockResolvedValue({ count: 0 });

    const err = await rejection(service.requestTosById(row.id, dto));

    expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(err.code).toBe(ApiErrorCode.KycStateInvalid);
    expect(prisma.blindpayReceiver.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: row.id,
          kycStatus: 'pending_user',
        }),
      }),
    );
  });

  it('refuses to send terms for a receiver that has not been approved', async () => {
    const { service, prisma, blindpay } = makeService();
    prisma.blindpayReceiver.findUnique.mockResolvedValue(
      baseRow({ kycStatus: 'pending_review' }),
    );

    const err = await rejection(service.requestTosById('rcv_1', dto));

    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.code).toBe(ApiErrorCode.KycStateInvalid);
    expect(blindpay.post).not.toHaveBeenCalled();
  });
});

describe('resolveTosCooldownMs — parsing only', () => {
  it('returns undefined without the internal marker', () => {
    expect(resolveTosCooldownMs(undefined, '0')).toBeUndefined();
    expect(resolveTosCooldownMs('0', '0')).toBeUndefined();
  });

  it('parses a non-negative value when the marker is present', () => {
    expect(resolveTosCooldownMs('1', '0')).toBe(0);
    expect(resolveTosCooldownMs(['1'], ['60000'])).toBe(60000);
  });

  it('rejects a missing or nonsensical value', () => {
    expect(resolveTosCooldownMs('1', '')).toBeUndefined();
    expect(resolveTosCooldownMs('1', 'soon')).toBeUndefined();
    expect(resolveTosCooldownMs('1', '-1')).toBeUndefined();
  });
});

describe('ReceiversService.setAccess — the kill-switch is not tenant-flippable', () => {
  it('refuses a plain kyc:write key with 403', async () => {
    const { service, prisma } = makeService();

    const err = await rejection(service.setAccess(CONSUMER, 'rcv_1', false));

    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(err.code).toBe(ApiErrorCode.InsufficientScope);
    expect(prisma.blindpayReceiver.update).not.toHaveBeenCalled();
  });

  it('lets an admin-role key toggle it, without returning raw', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayReceiver.findFirst.mockResolvedValue(baseRow());
    prisma.blindpayReceiver.update.mockResolvedValue(
      publicRow({ disabled: true }),
    );

    const result = await service.setAccess(ADMIN_CONSUMER, 'rcv_1', true);

    expect(prisma.blindpayReceiver.update).toHaveBeenCalledWith({
      where: { id: 'rcv_1' },
      data: { disabled: true },
      select: RECEIVER_PUBLIC_SELECT,
    });
    expect(result.disabled).toBe(true);
    expect(result).not.toHaveProperty('raw');
  });
});

describe('ReceiversService.remove — deleting a receiver is audited', () => {
  it('commits an audit row in the same transaction as the delete', async () => {
    const { service, prisma, auditRows } = makeService();
    const row = baseRow({
      kycStatus: 'pending_user',
      tosSentAt: new Date('2026-06-28T12:00:00.000Z'),
    });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);

    const result = await service.remove(CONSUMER, row.id);

    expect(result).toEqual({ id: row.id, deleted: true });
    expect(prisma.blindpayReceiver.delete).toHaveBeenCalledWith({
      where: { id: row.id },
    });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      actorId: 'cosmos_cred_1',
      actorRole: 'api_key:user',
      action: 'receivers.delete',
      resourceType: 'receiver',
      resourceId: row.id,
    });
    // The evidence the delete destroys is what the audit row has to preserve.
    expect(auditRows[0].metadata).toMatchObject({
      blindpayId: LOCAL_ID,
      kycStatus: 'pending_user',
      tosSentAt: '2026-06-28T12:00:00.000Z',
    });
  });

  it('records the delete of a receiver that exists at BlindPay too', async () => {
    const { service, prisma, blindpay, auditRows } = makeService();
    const row = baseRow({ blindpayId: REAL_ID, kycStatus: 'approved' });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);

    await service.remove(CONSUMER, row.id);

    expect(blindpay.delete).toHaveBeenCalledWith(
      `/instances/in_test/customers/${REAL_ID}`,
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].metadata).toMatchObject({ blindpayId: REAL_ID });
  });

  it('never writes the KYC dossier into the audit trail', async () => {
    const { service, prisma, auditRows } = makeService();
    prisma.blindpayReceiver.findFirst.mockResolvedValue(baseRow());

    await service.remove(CONSUMER, 'rcv_1');

    expect(JSON.stringify(auditRows[0])).not.toContain('123-45-6789');
  });
});
