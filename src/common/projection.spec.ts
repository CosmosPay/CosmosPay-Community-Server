import { project } from '@/common/projection';

describe('project', () => {
  const row = {
    id: 'sw_1',
    status: 'PENDING',
    consumerId: 'c_internal',
    settlementEpoch: 2,
    memo: null as string | null,
  };

  it('keeps exactly the columns the select names', () => {
    const out = project(row, { id: true, status: true, memo: true } as const);
    expect(out).toEqual({ id: 'sw_1', status: 'PENDING', memo: null });
    expect(Object.keys(out).sort()).toEqual(['id', 'memo', 'status']);
  });

  it('drops a column the select does not name, however it got onto the row', () => {
    const widened = { ...row, addedLater: 'secret' };
    const out = project(widened, { id: true } as const);
    expect(out).not.toHaveProperty('consumerId');
    expect(out).not.toHaveProperty('addedLater');
  });
});
