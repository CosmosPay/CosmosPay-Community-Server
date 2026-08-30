/* eslint-disable
  @typescript-eslint/no-unsafe-argument,
  @typescript-eslint/no-unsafe-assignment,
  @typescript-eslint/no-unsafe-call,
  @typescript-eslint/no-unsafe-member-access,
  @typescript-eslint/no-unsafe-return,
  @typescript-eslint/no-unnecessary-type-assertion,
  @typescript-eslint/require-await
*/
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ReceiversService, resolveTosCooldownMs } from './receivers.service';
import { ALLOWED_TRANSITIONS, assertTransition } from './receiver-state';

const CONSUMER = { username: 'cosmos_u1' } as any;
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
    },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeService() {
  const prisma: any = {
    blindpayReceiver: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
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
    prisma as any,
    blindpay as any,
    consumers as any,
    sync as any,
    config as any,
  );
  return { service, prisma, blindpay, consumers, sync, config };
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
    expect(() => assertTransition('inactive', 'pending_user')).toThrow(
      ConflictException,
    );
    try {
      assertTransition('inactive', 'pending_user');
    } catch (err) {
      expect((err as ConflictException).message).toBe(
        "Cannot move receiver from 'inactive' to 'pending_user'",
      );
    }
  });

  it('allows pending_user → pending_review (re-review after post-approve edit)', () => {
    expect(() =>
      assertTransition('pending_user', 'pending_review'),
    ).not.toThrow();
  });

  it('rejects pending_user → inactive with 409', () => {
    expect(() => assertTransition('pending_user', 'inactive')).toThrow(
      ConflictException,
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

    await service.update(CONSUMER, row.id, { email: 'new@acme.com' } as any);

    expect(blindpay.put).not.toHaveBeenCalled();
    expect(prisma.blindpayReceiver.update).toHaveBeenCalled();
  });

  it('promotes inactive → pending_review when the merged payload has KYC data', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({ kycStatus: 'inactive' });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.update.mockImplementation(
      async ({ data }: any) => ({ ...row, ...data }),
    );

    const result = await service.update(CONSUMER, row.id, {
      tax_id: '123-45-6789',
    } as any);

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
    const row = baseRow({ kycStatus: 'inactive' });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.update.mockImplementation(
      async ({ data }: any) => ({ ...row, ...data }),
    );

    const result = await service.update(CONSUMER, row.id, {
      email: 'only-email@acme.com',
    } as any);

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

    await service.update(CONSUMER, row.id, { tax_id: '99-9999999' } as any);

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
    } as any);

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
    } as any);

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
    const mirrored = { ...row, email: 'updated@acme.com' };
    sync.mirrorReceiver.mockResolvedValue(mirrored);

    const result = await service.update(CONSUMER, row.id, {
      email: 'updated@acme.com',
      tos_id: 'tos_forged',
    } as any);

    expect(blindpay.put).toHaveBeenCalledWith(
      '/instances/in_test/customers/re_000000000000',
      { email: 'updated@acme.com' },
    );
    expect(sync.mirrorReceiver).toHaveBeenCalledWith('c1', {
      id: REAL_ID,
      email: 'updated@acme.com',
    });
    expect(result).toBe(mirrored);
  });
});

describe('ReceiversService.approve — transitions', () => {
  it('pending_review → pending_user succeeds', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({ kycStatus: 'pending_review' });
    prisma.blindpayReceiver.findUnique.mockResolvedValue(row);
    blindpay.post.mockResolvedValue({ url: 'https://tos.example/accept' });
    prisma.blindpayReceiver.update.mockImplementation(
      async ({ data }: any) => ({ ...row, ...data }),
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
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.approveById('rcv_1', 'https://app.example.com/cb'),
    ).rejects.toThrow("Cannot move receiver from 'inactive' to 'pending_user'");
  });
});

describe('ReceiversService.enable — transitions', () => {
  it('pending_user → verifying (active) via enable succeeds', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    const row = baseRow({
      kycStatus: 'pending_user',
      raw: {
        type: 'individual',
        kyc_type: 'standard',
        email: 'jane@acme.com',
        country: 'US',
        tax_id: '123-45-6789',
      },
    });
    prisma.blindpayReceiver.findUnique.mockResolvedValue(row);
    const created = {
      id: REAL_ID,
      kyc_status: 'verifying',
      type: 'individual',
      email: 'jane@acme.com',
    };
    blindpay.post.mockResolvedValue(created);
    prisma.blindpayReceiver.update.mockResolvedValue({
      ...row,
      blindpayId: REAL_ID,
    });
    const mirrored = {
      ...row,
      blindpayId: REAL_ID,
      kycStatus: 'verifying',
    };
    sync.mirrorReceiver.mockResolvedValue(mirrored);

    const result = await service.enableById(row.id, 'tos_abc');

    expect(blindpay.post).toHaveBeenCalledWith('/instances/in_test/customers', {
      type: 'individual',
      kyc_type: 'standard',
      email: 'jane@acme.com',
      country: 'US',
      tax_id: '123-45-6789',
      tos_id: 'tos_abc',
    });
    expect(prisma.blindpayReceiver.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { blindpayId: REAL_ID },
    });
    expect(sync.mirrorReceiver).toHaveBeenCalledWith('c1', created);
    expect(
      prisma.blindpayReceiver.update.mock.invocationCallOrder[0],
    ).toBeLessThan(sync.mirrorReceiver.mock.invocationCallOrder[0]);
    expect(result.kycStatus).toBe('verifying');
    expect(result.blindpayId).toBe(REAL_ID);
  });

  it('inactive → verifying via enable returns 409', async () => {
    const { service, prisma, blindpay } = makeService();
    prisma.blindpayReceiver.findUnique.mockResolvedValue(
      baseRow({ kycStatus: 'inactive' }),
    );

    await expect(service.enableById('rcv_1', 'tos_abc')).rejects.toBeInstanceOf(
      ConflictException,
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
      ConflictException,
    );
    expect(blindpay.post).not.toHaveBeenCalled();
  });
});

describe('resolveTosCooldownMs', () => {
  it.each([
    [undefined, undefined, undefined],
    ['1', '0', 0],
    ['1', 'abc', undefined],
    ['0', '0', undefined],
    [['1', '0'], ['60000', '0'], 60_000],
    ['1', '', undefined],
    ['1', '-1', undefined],
  ])(
    'resolves internal=%p cooldown=%p to %p',
    (internal, cooldown, expected) => {
      expect(resolveTosCooldownMs(internal, cooldown)).toBe(expected);
    },
  );
});

describe('ReceiversService.create', () => {
  const bareDto = {
    type: 'individual',
    kyc_type: 'standard',
    email: 'jane@acme.com',
    country: 'US',
  };

  it('creates a bare registration as inactive and preserves the full raw dto', async () => {
    const { service, prisma } = makeService();
    prisma.blindpayReceiver.create.mockResolvedValue(baseRow());

    await service.create(CONSUMER, bareDto as any);

    expect(prisma.blindpayReceiver.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        consumerId: 'c1',
        blindpayId: expect.stringMatching(/^local_/),
        kycStatus: 'inactive',
        raw: bareDto,
      }),
    });
  });

  it.each([
    ['tax_id', { tax_id: '123-45-6789' }],
    ['selfie_file', { selfie_file: 'https://files.example/selfie' }],
  ])(
    'creates a payload containing %s as pending_review',
    async (_name, kyc) => {
      const { service, prisma } = makeService();
      prisma.blindpayReceiver.create.mockResolvedValue(baseRow());
      const dto = { ...bareDto, ...kyc };

      await service.create(CONSUMER, dto as any);

      expect(prisma.blindpayReceiver.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          kycStatus: 'pending_review',
          raw: dto,
        }),
      });
    },
  );
});

describe('ReceiversService request ToS cooldown', () => {
  function setup(overrides: Record<string, unknown> = {}) {
    const context = makeService();
    const row = baseRow({
      kycStatus: 'pending_user',
      tosSentAt: null,
      ...overrides,
    });
    context.prisma.blindpayReceiver.findUnique.mockResolvedValue(row);
    context.prisma.blindpayReceiver.update.mockImplementation(
      async ({ data }: any) => ({ ...row, ...data }),
    );
    context.blindpay.post.mockResolvedValue({
      url: 'https://tos.example/accept',
    });
    return { ...context, row };
  }

  it('rejects ToS outside pending_user', async () => {
    const { service, prisma, blindpay } = setup({ kycStatus: 'inactive' });

    await expect(
      service.requestTosById('rcv_1', {
        channel: 'email',
        redirect_url: 'https://app.example.com/cb',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.blindpayReceiver.update).not.toHaveBeenCalled();
    expect(blindpay.post).not.toHaveBeenCalled();
  });

  it('blocks the email channel inside the default 24h window', async () => {
    const { service, blindpay } = setup({
      tosSentAt: new Date(Date.now() - 1_000),
    });

    await expect(
      service.requestTosById('rcv_1', {
        channel: 'email',
        redirect_url: 'https://app.example.com/cb',
      }),
    ).rejects.toThrow('already sent');
    expect(blindpay.post).not.toHaveBeenCalled();
  });

  it('allows email outside the default window and stores tosSentAt', async () => {
    const { service, prisma } = setup({
      tosSentAt: new Date(Date.now() - 24 * 60 * 60 * 1_000 - 1),
    });

    const result = await service.requestTosById('rcv_1', {
      channel: 'email',
      redirect_url: 'https://app.example.com/cb',
    });

    expect(result).toEqual({
      url: 'https://tos.example/accept',
      email: 'jane@acme.com',
      channel: 'email',
    });
    expect(prisma.blindpayReceiver.update).toHaveBeenCalledWith({
      where: { id: 'rcv_1' },
      data: { tosSentAt: expect.any(Date) },
    });
  });

  it('allows a trusted cooldown of zero even one second after the last email', async () => {
    const { service, blindpay } = setup({
      tosSentAt: new Date(Date.now() - 1_000),
    });

    await expect(
      service.requestTosById(
        'rcv_1',
        {
          channel: 'email',
          redirect_url: 'https://app.example.com/cb',
        },
        0,
      ),
    ).resolves.toEqual(expect.objectContaining({ channel: 'email' }));
    expect(blindpay.post).toHaveBeenCalledTimes(1);
  });

  it.each([Number.NaN, -1])(
    'falls back to 24h for invalid cooldown %p',
    async (cooldown) => {
      const { service, blindpay } = setup({
        tosSentAt: new Date(Date.now() - 1_000),
      });

      await expect(
        service.requestTosById(
          'rcv_1',
          {
            channel: 'email',
            redirect_url: 'https://app.example.com/cb',
          },
          cooldown,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(blindpay.post).not.toHaveBeenCalled();
    },
  );

  it('never rate-limits the code channel and does not write tosSentAt', async () => {
    const { service, prisma } = setup({
      tosSentAt: new Date(Date.now() - 1_000),
    });

    await expect(
      service.requestTosById('rcv_1', {
        channel: 'code',
        redirect_url: 'https://app.example.com/cb',
      }),
    ).resolves.toEqual(expect.objectContaining({ channel: 'code' }));
    expect(prisma.blindpayReceiver.update).not.toHaveBeenCalled();
  });
});

describe('ReceiversService ownership and access', () => {
  it('returns 404 for another consumer and proves consumerId is in the query', async () => {
    const { service, prisma } = makeService();
    const foreign = baseRow({ consumerId: 'c2' });
    prisma.blindpayReceiver.findFirst.mockImplementation(
      async ({ where }: any) => (where.consumerId === 'c1' ? null : foreign),
    );

    await expect(
      service.findReceiverOrThrow('c1', foreign.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.blindpayReceiver.findFirst).toHaveBeenCalledWith({
      where: { id: foreign.id, consumerId: 'c1' },
    });
  });

  it('returns an owned receiver', async () => {
    const { service, prisma } = makeService();
    const row = baseRow();
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);

    await expect(service.findReceiverOrThrow('c1', row.id)).resolves.toBe(row);
  });

  it('rejects disabled receivers and accepts enabled receivers', () => {
    const { service } = makeService();

    expect(() => service.assertEnabled({ disabled: true })).toThrow(
      ForbiddenException,
    );
    expect(() => service.assertEnabled({ disabled: false })).not.toThrow();
  });
});

describe('ReceiversService enable idempotency', () => {
  it('calling enable twice on a real receiver never POSTs /customers twice', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    const row = baseRow({
      blindpayId: REAL_ID,
      kycStatus: 'pending_user',
    });
    prisma.blindpayReceiver.findUnique.mockResolvedValue(row);
    blindpay.get.mockResolvedValue({ id: REAL_ID, kyc_status: 'verifying' });
    blindpay.post.mockResolvedValue({
      id: 're_duplicate',
      kyc_status: 'verifying',
    });
    sync.mirrorReceiver.mockResolvedValue(row);

    await service.enableById(row.id, 'tos_1');
    await service.enableById(row.id, 'tos_1');

    expect(blindpay.post).not.toHaveBeenCalled();
    expect(blindpay.get).toHaveBeenCalledTimes(2);
  });
});

describe('ReceiversService scoped wrappers and CRUD', () => {
  it('approve scopes ownership before delegating to approveById', async () => {
    const { service, prisma } = makeService();
    const row = baseRow({ kycStatus: 'pending_review' });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    const outcome = {
      receiver: row,
      url: 'https://tos.example/accept',
      email: row.email,
    };
    const delegated = jest
      .spyOn(service, 'approveById')
      .mockResolvedValue(outcome as any);

    await expect(
      service.approve(CONSUMER, row.id, 'https://app.example.com/cb'),
    ).resolves.toBe(outcome);
    expect(delegated).toHaveBeenCalledWith(
      row.id,
      'https://app.example.com/cb',
    );
  });

  it('requestTos scopes ownership before delegating to requestTosById', async () => {
    const { service, prisma } = makeService();
    const row = baseRow({ kycStatus: 'pending_user' });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    const outcome = {
      url: 'https://tos.example/accept',
      email: row.email,
      channel: 'email' as const,
    };
    const delegated = jest
      .spyOn(service, 'requestTosById')
      .mockResolvedValue(outcome);

    await expect(
      service.requestTos(
        CONSUMER,
        row.id,
        {
          channel: 'email',
          redirect_url: 'https://app.example.com/cb',
        },
        0,
      ),
    ).resolves.toBe(outcome);
    expect(delegated).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({ channel: 'email' }),
      0,
    );
  });

  it('enable scopes ownership before delegating to enableById', async () => {
    const { service, prisma } = makeService();
    const row = baseRow({ kycStatus: 'pending_user' });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    const delegated = jest
      .spyOn(service, 'enableById')
      .mockResolvedValue(row as any);

    await expect(service.enable(CONSUMER, row.id, 'tos_1')).resolves.toBe(row);
    expect(delegated).toHaveBeenCalledWith(row.id, 'tos_1');
  });

  it('lists only the local consumer receivers', async () => {
    const { service, prisma } = makeService();
    const rows = [baseRow()];
    prisma.blindpayReceiver.findMany.mockResolvedValue(rows);

    await expect(service.findAll(CONSUMER)).resolves.toEqual({
      data: rows,
      total: 1,
    });
    expect(prisma.blindpayReceiver.findMany).toHaveBeenCalledWith({
      where: { consumerId: 'c1' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns local receivers without calling BlindPay', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow();
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);

    await expect(service.findOne(CONSUMER, row.id)).resolves.toBe(row);
    expect(blindpay.get).not.toHaveBeenCalled();
  });

  it('refreshes remote receivers and falls back locally on provider failure', async () => {
    const { service, prisma, blindpay, sync } = makeService();
    const row = baseRow({ blindpayId: REAL_ID, kycStatus: 'verifying' });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    blindpay.get
      .mockResolvedValueOnce({ id: REAL_ID, kyc_status: 'approved' })
      .mockRejectedValueOnce(new Error('provider down'));
    const mirrored = { ...row, kycStatus: 'approved' };
    sync.mirrorReceiver.mockResolvedValue(mirrored);

    await expect(service.findOne(CONSUMER, row.id)).resolves.toBe(mirrored);
    await expect(service.findOne(CONSUMER, row.id)).resolves.toBe(row);
  });

  it('removes a local receiver without a provider DELETE', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow();
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.delete.mockResolvedValue(row);

    await expect(service.remove(CONSUMER, row.id)).resolves.toEqual({
      id: row.id,
      deleted: true,
    });
    expect(blindpay.delete).not.toHaveBeenCalled();
  });

  it('deletes a remote receiver at BlindPay before deleting its mirror', async () => {
    const { service, prisma, blindpay } = makeService();
    const row = baseRow({ blindpayId: REAL_ID });
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.delete.mockResolvedValue(row);

    await service.remove(CONSUMER, row.id);

    expect(blindpay.delete).toHaveBeenCalledWith(
      '/instances/in_test/customers/re_000000000000',
    );
    expect(blindpay.delete.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.blindpayReceiver.delete.mock.invocationCallOrder[0],
    );
  });

  it('updates the owner/admin access switch after the ownership check', async () => {
    const { service, prisma } = makeService();
    const row = baseRow();
    prisma.blindpayReceiver.findFirst.mockResolvedValue(row);
    prisma.blindpayReceiver.update.mockResolvedValue({
      ...row,
      disabled: true,
    });

    await service.setAccess(CONSUMER, row.id, true);

    expect(prisma.blindpayReceiver.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { disabled: true },
    });
  });
});
