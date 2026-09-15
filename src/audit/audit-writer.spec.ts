import { recordAuditInTransaction, toAuditEntry } from '@/audit/audit-writer';

describe('toAuditEntry', () => {
  it('maps the actor and action onto the audit row columns', () => {
    expect(
      toAuditEntry(
        { id: 'cosmos_u1', role: 'owner' },
        'receivers.setAccess',
        'receiver',
        'rcv_1',
        { disabled: true },
      ),
    ).toEqual({
      actorId: 'cosmos_u1',
      actorRole: 'owner',
      action: 'receivers.setAccess',
      resourceType: 'receiver',
      resourceId: 'rcv_1',
      metadata: { disabled: true },
    });
  });

  it('leaves metadata undefined when none is given', () => {
    const entry = toAuditEntry(
      { id: 'cosmos_u1', role: 'admin' },
      'receivers.enable',
      'receiver',
      'rcv_1',
    );

    expect(entry.metadata).toBeUndefined();
  });

  it('copies only id and role from a richer principal', () => {
    // An AdminPrincipal-shaped object carrying extra fields must not leak them
    // into the append-only trail.
    const actor = { id: 'cosmos_u1', role: 'owner', token: 'secret' };

    expect(
      Object.keys(toAuditEntry(actor, 'a', 'receiver', 'rcv_1')).sort(),
    ).toEqual(
      [
        'action',
        'actorId',
        'actorRole',
        'metadata',
        'resourceId',
        'resourceType',
      ].sort(),
    );
  });
});

describe('recordAuditInTransaction', () => {
  it('writes the entry through the transaction client it was given', async () => {
    const tx = {
      adminAuditLog: {
        create: jest.fn(async ({ data }: any) => ({ id: 'aud_1', ...data })),
      },
    };
    const entry = toAuditEntry(
      { id: 'cosmos_u1', role: 'owner' },
      'receivers.approve',
      'receiver',
      'rcv_1',
      { redirect_url: 'https://app.example.com/cb' },
    );

    const row = await recordAuditInTransaction(tx as any, entry);

    expect(tx.adminAuditLog.create).toHaveBeenCalledWith({ data: entry });
    expect(row).toMatchObject({ id: 'aud_1', action: 'receivers.approve' });
  });
});
