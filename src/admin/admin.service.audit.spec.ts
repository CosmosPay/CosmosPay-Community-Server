import { HttpStatus, NotFoundException } from '@nestjs/common';
import { AdminService } from '@/admin/admin.service';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  RECEIVER_PUBLIC_SELECT,
  ReceiversService,
} from '@/kyc/receivers/receivers.service';

const ACTOR = { id: 'cosmos_u1', role: 'owner' };

/**
 * The write moved into `ReceiversService.setAccessById`, so these run the REAL receivers
 * service over one Prisma fake rather than a stub of it: what is under test is still
 * that the admin kill-switch and its audit row commit or roll back together, and a stub
 * would only prove that AdminService calls a method.
 */
function makeService(prisma: any) {
  const receivers = new ReceiversService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return new AdminService(prisma, receivers);
}

describe('AdminService.setReceiverAccess (atomic audit)', () => {
  it('rolls back the mutation when the audit insert fails', async () => {
    let disabled = false;
    const tx = {
      blindpayReceiver: {
        findUnique: jest.fn(async () => ({ id: 'rcv_1' })),
        update: jest.fn(async ({ data }: any) => {
          disabled = data.disabled;
          return { id: 'rcv_1', disabled };
        }),
      },
      adminAuditLog: {
        create: jest.fn(async () => {
          throw new Error('audit write failed');
        }),
      },
    };

    const prisma = {
      blindpayReceiver: { findUnique: jest.fn() },
      $transaction: jest.fn(async (fn: any) => {
        try {
          return await fn(tx);
        } catch (err) {
          // Simulate rollback of the in-memory mutation.
          disabled = false;
          throw err;
        }
      }),
    };

    const service = makeService(prisma);

    await expect(
      service.setReceiverAccess('rcv_1', true, ACTOR),
    ).rejects.toThrow('audit write failed');

    expect(disabled).toBe(false);
    expect(tx.adminAuditLog.create).toHaveBeenCalled();
    expect(tx.blindpayReceiver.update).toHaveBeenCalled();
    // A rolled-back toggle is not read back as though it had happened.
    expect(prisma.blindpayReceiver.findUnique).not.toHaveBeenCalled();
  });

  it('commits mutation and audit together on success', async () => {
    const created: any[] = [];
    let disabled = false;
    const tx = {
      blindpayReceiver: {
        findUnique: jest.fn(async () => ({ id: 'rcv_1' })),
        update: jest.fn(async ({ data }: any) => {
          disabled = data.disabled;
          return { id: 'rcv_1', disabled };
        }),
      },
      adminAuditLog: {
        create: jest.fn(async ({ data }: any) => {
          created.push(data);
          return data;
        }),
      },
    };
    const prisma = {
      blindpayReceiver: {
        findUnique: jest.fn(async () => ({
          id: 'rcv_1',
          disabled,
          consumer: null,
        })),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const service = makeService(prisma);

    const result = await service.setReceiverAccess('rcv_1', true, ACTOR);

    expect(result.disabled).toBe(true);
    expect(created).toEqual([
      expect.objectContaining({
        actorId: 'cosmos_u1',
        action: 'receivers.setAccess',
        resourceId: 'rcv_1',
      }),
    ]);
    // The row is byte-for-byte what AdminService wrote before the write moved.
    expect(created[0]).toEqual({
      actorId: 'cosmos_u1',
      actorRole: 'owner',
      action: 'receivers.setAccess',
      resourceType: 'receiver',
      resourceId: 'rcv_1',
      metadata: { disabled: true },
    });
    // Mutation and audit ran on the same transaction client, in one transaction.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.blindpayReceiver.update).toHaveBeenCalledWith({
      where: { id: 'rcv_1' },
      data: { disabled: true },
      select: RECEIVER_PUBLIC_SELECT,
    });
  });

  it('answers in the admin shape: owning consumer attached, KYC dossier omitted', async () => {
    const tx = {
      blindpayReceiver: {
        findUnique: jest.fn(async () => ({ id: 'rcv_1' })),
        update: jest.fn(async () => ({ id: 'rcv_1', disabled: true })),
      },
      adminAuditLog: { create: jest.fn(async ({ data }: any) => data) },
    };
    const adminRow = {
      id: 'rcv_1',
      disabled: true,
      consumer: { apisixUsername: 'cosmos_u1', credentialId: 'cred_1' },
    };
    const prisma = {
      blindpayReceiver: { findUnique: jest.fn(async () => adminRow) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const service = makeService(prisma);

    const result = await service.setReceiverAccess('rcv_1', true, ACTOR);

    expect(result).toBe(adminRow);
    expect(prisma.blindpayReceiver.findUnique).toHaveBeenCalledWith({
      where: { id: 'rcv_1' },
      include: {
        consumer: { select: { apisixUsername: true, credentialId: true } },
      },
      omit: { raw: true },
    });
  });

  it('throws NotFound without writing audit when the receiver is missing', async () => {
    const tx = {
      blindpayReceiver: {
        findUnique: jest.fn(async () => null),
        update: jest.fn(),
      },
      adminAuditLog: { create: jest.fn() },
    };
    const prisma = {
      blindpayReceiver: { findUnique: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const service = makeService(prisma);

    // `ApiError.notFound` now, where this was a bare NotFoundException: both reach the
    // wire as 404 / `not_found` / "Receiver not found", which is what is asserted.
    const err = await service
      .setReceiverAccess('missing', true, ACTOR)
      .then(() => null)
      .catch((e: unknown) => e as ApiError);

    expect(err).toBeInstanceOf(ApiError);
    expect(err!.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(err!.code).toBe(ApiErrorCode.NotFound);
    expect(err!.message).toBe('Receiver not found');
    expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
    expect(tx.blindpayReceiver.update).not.toHaveBeenCalled();
  });

  it('404s if the receiver vanished between the committed toggle and the read', async () => {
    const tx = {
      blindpayReceiver: {
        findUnique: jest.fn(async () => ({ id: 'rcv_1' })),
        update: jest.fn(async () => ({ id: 'rcv_1', disabled: true })),
      },
      adminAuditLog: { create: jest.fn(async ({ data }: any) => data) },
    };
    const prisma = {
      blindpayReceiver: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const service = makeService(prisma);

    await expect(
      service.setReceiverAccess('rcv_1', true, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
