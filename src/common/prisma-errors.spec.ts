import {
  isUniqueViolation,
  uniqueViolationColumns,
  uniqueViolationNames,
} from '@/common/prisma-errors';

/** A P2002 as `@prisma/adapter-pg` reports it: no target, a named constraint. */
function adapterViolation(constraint: Record<string, unknown>): unknown {
  return {
    code: 'P2002',
    meta: { driverAdapterError: { cause: { constraint } } },
  };
}

describe('isUniqueViolation', () => {
  it('is true only for P2002', () => {
    expect(isUniqueViolation({ code: 'P2002' })).toBe(true);
    expect(isUniqueViolation({ code: 'P2025' })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

describe('uniqueViolationColumns', () => {
  it('reads the fields Prisma reports in meta.target', () => {
    expect(
      uniqueViolationColumns({
        code: 'P2002',
        meta: { target: ['consumerId', 'txHash'] },
      }),
    ).toEqual(['consumerId', 'txHash']);
  });

  it('accepts a target reported as a single string', () => {
    expect(
      uniqueViolationColumns({ code: 'P2002', meta: { target: 'txHash' } }),
    ).toEqual(['txHash']);
  });

  it('falls back to the driver adapter constraint fields', () => {
    expect(
      uniqueViolationColumns(
        adapterViolation({ fields: ['consumerId', 'txHash'] }),
      ),
    ).toEqual(['consumerId', 'txHash']);
  });

  it('falls back to the driver adapter index name', () => {
    expect(
      uniqueViolationColumns(
        adapterViolation({ index: 'payment_intent_consumerId_txHash_key' }),
      ),
    ).toEqual(['payment_intent_consumerId_txHash_key']);
  });

  it('is empty when the client named nothing at all', () => {
    expect(uniqueViolationColumns({ code: 'P2002' })).toEqual([]);
    expect(uniqueViolationColumns({ code: 'P2002', meta: {} })).toEqual([]);
    expect(
      uniqueViolationColumns({ code: 'P2002', meta: { target: [] } }),
    ).toEqual([]);
  });
});

describe('uniqueViolationNames', () => {
  it('matches a field name on either path', () => {
    expect(
      uniqueViolationNames(
        { code: 'P2002', meta: { target: ['consumerId', 'txHash'] } },
        'txHash',
      ),
    ).toBe(true);
    expect(
      uniqueViolationNames(
        adapterViolation({ fields: ['consumerId', 'txHash'] }),
        'txHash',
      ),
    ).toBe(true);
  });

  it('matches a column inside an index name', () => {
    // The whole point of the fallback: the adapter names the index, so the
    // caller cannot compare for equality and still recognise its own column.
    expect(
      uniqueViolationNames(
        adapterViolation({ index: 'payment_intent_consumerId_txHash_key' }),
        'txHash',
      ),
    ).toBe(true);
  });

  it('does not match another column', () => {
    expect(
      uniqueViolationNames(
        { code: 'P2002', meta: { target: ['alias'] } },
        'txHash',
      ),
    ).toBe(false);
    expect(
      uniqueViolationNames(
        adapterViolation({ index: 'payment_intent_consumerId_memo_key' }),
        'txHash',
      ),
    ).toBe(false);
  });
});
