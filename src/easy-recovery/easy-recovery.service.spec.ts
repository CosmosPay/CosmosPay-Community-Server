import { HttpStatus } from '@nestjs/common';
import { EasyRecoveryStatus } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { EasyRecoveryService } from '@/easy-recovery/easy-recovery.service';
import { easyRecoveryCodeHash } from '@/easy-recovery/easy-recovery-core';
import {
  EASY_RECOVERY_MAX_ATTEMPTS,
  EASY_RECOVERY_TTL_MS,
} from '@/easy-recovery/easy-recovery.constants';

const RECEIVER_KEY = 'E75P6uryBMf9M1j8nAByGIHRdCeBKCJ-xnTzf3_pe20';
const CIPHERTEXT = 'c2VhbGVkLXRvLXRoZS1uZXctZGV2aWNl';
const CODE = '48213';

interface Row {
  id: string;
  receiverKey: string;
  status: EasyRecoveryStatus;
  ciphertext: string | null;
  codeHash: string | null;
  attempts: number;
  expiresAt: Date;
  createdAt: Date;
}

type Where = {
  id?: string | { in: string[] };
  status?: EasyRecoveryStatus;
  attempts?: { lt?: number; gte?: number };
  expiresAt?: { gt?: Date; lt?: Date };
};

function matches(row: Row, where: Where): boolean {
  if (typeof where.id === 'string' && row.id !== where.id) return false;
  if (typeof where.id === 'object' && !where.id.in.includes(row.id)) {
    return false;
  }
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.attempts?.lt !== undefined && !(row.attempts < where.attempts.lt))
    return false;
  if (
    where.attempts?.gte !== undefined &&
    !(row.attempts >= where.attempts.gte)
  )
    return false;
  if (where.expiresAt?.gt && !(row.expiresAt > where.expiresAt.gt))
    return false;
  if (where.expiresAt?.lt && !(row.expiresAt < where.expiresAt.lt))
    return false;
  return true;
}

function pick(row: Row, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(
    Object.keys(select)
      .filter((key) => select[key])
      .map((key) => [key, row[key as keyof Row]]),
  );
}

/** Yields to every other pending request, the way a database round trip does. */
const roundTrip = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The `easy_recovery_session` table, in memory, with Postgres' single-statement
 * semantics: every call yields first (so concurrent requests interleave between
 * statements, as they do against a real database), then reads or writes in one
 * synchronous step (so each statement is atomic and its WHERE is evaluated on
 * the row as it is at that moment — what Postgres re-checks for an UPDATE that
 * waited on a row lock).
 */
function fakeTable() {
  const rows = new Map<string, Row>();
  /** The highest `attempts` any write ever left on any row. */
  let maxAttempts = 0;

  const delegate = {
    create: jest.fn(
      async ({
        data,
        select,
      }: {
        data: Pick<Row, 'id' | 'receiverKey' | 'expiresAt'>;
        select?: Record<string, boolean>;
      }) => {
        await roundTrip();
        if (rows.has(data.id)) throw new Error('unique violation');
        const row: Row = {
          status: EasyRecoveryStatus.OPEN,
          ciphertext: null,
          codeHash: null,
          attempts: 0,
          createdAt: new Date(),
          ...data,
        };
        rows.set(row.id, row);
        return pick(row, select);
      },
    ),
    findUnique: jest.fn(
      async ({
        where,
        select,
      }: {
        where: { id: string };
        select?: Record<string, boolean>;
      }) => {
        await roundTrip();
        const row = rows.get(where.id);
        return row ? pick(row, select) : null;
      },
    ),
    findMany: jest.fn(
      async ({
        where,
        take,
      }: {
        where: Where;
        take: number;
        select: { id: true };
      }) => {
        await roundTrip();
        return [...rows.values()]
          .filter((row) => matches(row, where))
          .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
          .slice(0, take)
          .map((row) => ({ id: row.id }));
      },
    ),
    updateMany: jest.fn(
      async ({
        where,
        data,
      }: {
        where: Where;
        data: Partial<Omit<Row, 'attempts'>> & {
          attempts?: { increment: number };
        };
      }) => {
        await roundTrip();
        let count = 0;
        for (const row of rows.values()) {
          if (!matches(row, where)) continue;
          const { attempts, ...rest } = data;
          Object.assign(row, rest);
          if (attempts) row.attempts += attempts.increment;
          maxAttempts = Math.max(maxAttempts, row.attempts);
          count++;
        }
        return { count };
      },
    ),
    deleteMany: jest.fn(async ({ where }: { where: Where }) => {
      await roundTrip();
      let count = 0;
      for (const row of [...rows.values()]) {
        if (matches(row, where)) {
          rows.delete(row.id);
          count++;
        }
      }
      return { count };
    }),
  };

  return { rows, delegate, maxAttempts: () => maxAttempts };
}

function build() {
  const table = fakeTable();
  const prisma = { easyRecoverySession: table.delegate };
  const service = new EasyRecoveryService(prisma as never);
  return { service, table };
}

/** The ApiError a call rejected with. */
async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('expected the call to fail');
}

async function openSession(service: EasyRecoveryService) {
  const { id } = await service.createSession({ receiverKey: RECEIVER_KEY });
  return id;
}

async function offeredSession(service: EasyRecoveryService) {
  const id = await openSession(service);
  await service.offer(id, { ciphertext: CIPHERTEXT, code: CODE });
  return id;
}

/** A wrong code that is not {@link CODE}. */
const wrong = (n: number) => String(10000 + n);

describe('EasyRecoveryService', () => {
  describe('createSession', () => {
    it('opens an OPEN session for five minutes and answers only its id and expiry', async () => {
      const { service, table } = build();
      const before = Date.now();

      const created = await service.createSession({
        receiverKey: RECEIVER_KEY,
      });

      expect(Object.keys(created).sort()).toEqual(['expiresAt', 'id']);
      expect(created.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      const expiresAt = Date.parse(created.expiresAt);
      expect(expiresAt - before).toBeGreaterThanOrEqual(EASY_RECOVERY_TTL_MS);
      expect(expiresAt - Date.now()).toBeLessThanOrEqual(EASY_RECOVERY_TTL_MS);
      expect(EASY_RECOVERY_TTL_MS).toBe(300_000);

      const row = table.rows.get(created.id)!;
      expect(row).toMatchObject({
        receiverKey: RECEIVER_KEY,
        status: EasyRecoveryStatus.OPEN,
        ciphertext: null,
        codeHash: null,
        attempts: 0,
      });
      expect(row.expiresAt.toISOString()).toBe(created.expiresAt);
    });

    it('mints a different id every time', async () => {
      const { service } = build();
      const ids = await Promise.all(
        Array.from({ length: 10 }, () => openSession(service)),
      );
      expect(new Set(ids).size).toBe(10);
    });
  });

  describe('status', () => {
    it('answers the status and expiry, never the key, the ciphertext or the code', async () => {
      const { service, table } = build();
      const id = await offeredSession(service);

      const status = await service.status(id);

      expect(status).toEqual({
        status: 'offered',
        expiresAt: table.rows.get(id)!.expiresAt.toISOString(),
      });
      // Not only absent from the answer: never selected, so no later change to
      // the response can carry one out.
      const select = table.delegate.findUnique.mock.calls.at(-1)![0].select!;
      expect(select).not.toHaveProperty('receiverKey');
      expect(select).not.toHaveProperty('ciphertext');
      expect(select).not.toHaveProperty('codeHash');
    });

    it('follows the session through open, offered and claimed', async () => {
      const { service } = build();
      const id = await openSession(service);
      expect((await service.status(id)).status).toBe('open');

      await service.offer(id, { ciphertext: CIPHERTEXT, code: CODE });
      expect((await service.status(id)).status).toBe('offered');

      await service.claim(id, { code: CODE });
      // The tombstone the old device's poll is waiting for.
      expect((await service.status(id)).status).toBe('claimed');
    });

    it('is a 404 for an unknown session', async () => {
      const { service } = build();
      const error = await failure(service.status('AAAAAAAAAAAAAAAAAAAAAA'));
      expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(error.code).toBe(ApiErrorCode.EasyRecoveryNotFound);
    });

    it('is a 404 for an id this service could not have minted, without a read', async () => {
      const { service, table } = build();
      const error = await failure(service.status('not-an-id'));
      expect(error.code).toBe(ApiErrorCode.EasyRecoveryNotFound);
      expect(table.delegate.findUnique).not.toHaveBeenCalled();
    });

    it('is a 404 once expired, whether or not the sweeper has run', async () => {
      const { service, table } = build();
      const id = await offeredSession(service);
      table.rows.get(id)!.expiresAt = new Date(Date.now() - 1);

      const error = await failure(service.status(id));
      expect(error.code).toBe(ApiErrorCode.EasyRecoveryNotFound);
    });
  });

  describe('offer', () => {
    it('stores the ciphertext and a hash of the code, never the code', async () => {
      const { service, table } = build();
      const id = await openSession(service);

      await expect(
        service.offer(id, { ciphertext: CIPHERTEXT, code: CODE }),
      ).resolves.toEqual({ status: 'offered' });

      const row = table.rows.get(id)!;
      expect(row.status).toBe(EasyRecoveryStatus.OFFERED);
      expect(row.ciphertext).toBe(CIPHERTEXT);
      expect(row.codeHash).toBe(easyRecoveryCodeHash(id, CODE));
      expect(JSON.stringify(row)).not.toContain(CODE);
    });

    it('accepts one offer: a second one is a 409 and changes nothing', async () => {
      const { service, table } = build();
      const id = await offeredSession(service);

      const error = await failure(
        service.offer(id, { ciphertext: 'b3RoZXI', code: '99999' }),
      );

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.code).toBe(ApiErrorCode.EasyRecoveryAlreadyOffered);
      const row = table.rows.get(id)!;
      expect(row.ciphertext).toBe(CIPHERTEXT);
      expect(row.codeHash).toBe(easyRecoveryCodeHash(id, CODE));
    });

    it('lets exactly one of several racing offers land', async () => {
      const { service, table } = build();
      const id = await openSession(service);

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          service.offer(id, {
            ciphertext: `Y2lwaGVy${i}`,
            code: wrong(i),
          }),
        ),
      );

      const won = results.filter((r) => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect((result.reason as ApiError).code).toBe(
            ApiErrorCode.EasyRecoveryAlreadyOffered,
          );
        }
      }
      // Whichever landed, the row holds that one offer whole, not a mix.
      const row = table.rows.get(id)!;
      const winner = Number(row.ciphertext!.replace('Y2lwaGVy', ''));
      expect(row.codeHash).toBe(easyRecoveryCodeHash(id, wrong(winner)));
    });

    it('refuses an offer on a claimed session as already offered', async () => {
      const { service } = build();
      const id = await offeredSession(service);
      await service.claim(id, { code: CODE });

      const error = await failure(
        service.offer(id, { ciphertext: CIPHERTEXT, code: CODE }),
      );
      expect(error.code).toBe(ApiErrorCode.EasyRecoveryAlreadyOffered);
    });

    it('is a 404 for an unknown or expired session', async () => {
      const { service, table } = build();
      expect(
        (
          await failure(
            service.offer('AAAAAAAAAAAAAAAAAAAAAA', {
              ciphertext: CIPHERTEXT,
              code: CODE,
            }),
          )
        ).code,
      ).toBe(ApiErrorCode.EasyRecoveryNotFound);

      const id = await openSession(service);
      table.rows.get(id)!.expiresAt = new Date(Date.now() - 1);
      const error = await failure(
        service.offer(id, { ciphertext: CIPHERTEXT, code: CODE }),
      );
      expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(error.code).toBe(ApiErrorCode.EasyRecoveryNotFound);
      expect(table.rows.get(id)!.ciphertext).toBeNull();
    });
  });

  describe('claim', () => {
    it('is a 409 before the old device offered, and costs no attempt', async () => {
      const { service, table } = build();
      const id = await openSession(service);

      const error = await failure(service.claim(id, { code: CODE }));

      expect(error.getStatus()).toBe(HttpStatus.CONFLICT);
      expect(error.code).toBe(ApiErrorCode.EasyRecoveryNotOffered);
      expect(table.rows.get(id)!.attempts).toBe(0);
    });

    it('hands the ciphertext to the right code once, then wipes it', async () => {
      const { service, table } = build();
      const id = await offeredSession(service);

      await expect(service.claim(id, { code: CODE })).resolves.toEqual({
        ciphertext: CIPHERTEXT,
      });

      const row = table.rows.get(id)!;
      expect(row.status).toBe(EasyRecoveryStatus.CLAIMED);
      expect(row.ciphertext).toBeNull();
      expect(row.codeHash).toBeNull();

      // A second claim, right code and all, finds nothing to hand out.
      const again = await failure(service.claim(id, { code: CODE }));
      expect(again.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(again.code).toBe(ApiErrorCode.EasyRecoveryNotFound);
    });

    it('answers a wrong code with 422 and what is left, counting down', async () => {
      const { service, table } = build();
      const id = await offeredSession(service);

      for (let n = 1; n < EASY_RECOVERY_MAX_ATTEMPTS; n++) {
        const error = await failure(service.claim(id, { code: wrong(n) }));
        expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        expect(error.code).toBe(ApiErrorCode.EasyRecoveryCodeInvalid);
        expect(error.details).toEqual({
          attemptsLeft: EASY_RECOVERY_MAX_ATTEMPTS - n,
        });
        // Where the envelope reads it from.
        expect(error.getResponse()).toMatchObject({
          code: 'easy_recovery_code_invalid',
          details: { attemptsLeft: EASY_RECOVERY_MAX_ATTEMPTS - n },
        });
        expect(table.rows.get(id)!.attempts).toBe(n);
      }
      // Still claimable by the right code with one attempt left.
      expect(table.rows.get(id)!.status).toBe(EasyRecoveryStatus.OFFERED);
    });

    it('burns the session on the fifth wrong code: 410, row and ciphertext deleted', async () => {
      const { service, table } = build();
      const id = await offeredSession(service);
      for (let n = 1; n < EASY_RECOVERY_MAX_ATTEMPTS; n++) {
        await failure(service.claim(id, { code: wrong(n) }));
      }

      const burned = await failure(service.claim(id, { code: wrong(99) }));

      expect(burned.getStatus()).toBe(HttpStatus.GONE);
      expect(burned.code).toBe(ApiErrorCode.EasyRecoveryBurned);
      expect(table.rows.has(id)).toBe(false);

      // The right code is worthless now, and the poll sees a missing session.
      const late = await failure(service.claim(id, { code: CODE }));
      expect(late.code).toBe(ApiErrorCode.EasyRecoveryNotFound);
      expect((await failure(service.status(id))).code).toBe(
        ApiErrorCode.EasyRecoveryNotFound,
      );
    });

    it('still takes the right code after four wrong ones', async () => {
      const { service } = build();
      const id = await offeredSession(service);
      for (let n = 1; n < EASY_RECOVERY_MAX_ATTEMPTS; n++) {
        await failure(service.claim(id, { code: wrong(n) }));
      }

      await expect(service.claim(id, { code: CODE })).resolves.toEqual({
        ciphertext: CIPHERTEXT,
      });
    });

    it('is a 404 once expired, and an expired guess is not counted', async () => {
      const { service, table } = build();
      const id = await offeredSession(service);
      table.rows.get(id)!.expiresAt = new Date(Date.now() - 1);

      const right = await failure(service.claim(id, { code: CODE }));
      const wrongOne = await failure(service.claim(id, { code: wrong(1) }));

      expect(right.code).toBe(ApiErrorCode.EasyRecoveryNotFound);
      expect(wrongOne.code).toBe(ApiErrorCode.EasyRecoveryNotFound);
      expect(table.rows.get(id)!.attempts).toBe(0);
      expect(table.rows.get(id)!.status).toBe(EasyRecoveryStatus.OFFERED);
    });

    it('is a 404 for an unknown session or a malformed id', async () => {
      const { service, table } = build();
      expect(
        (await failure(service.claim('AAAAAAAAAAAAAAAAAAAAAA', { code: CODE })))
          .code,
      ).toBe(ApiErrorCode.EasyRecoveryNotFound);
      expect(
        (await failure(service.claim('../sessions', { code: CODE }))).code,
      ).toBe(ApiErrorCode.EasyRecoveryNotFound);
      expect(table.delegate.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('racing guesses', () => {
    it('never counts more than five wrong codes, however many arrive at once', async () => {
      const { service, table } = build();
      const id = await offeredSession(service);

      const results = await Promise.allSettled(
        Array.from({ length: 40 }, (_, n) =>
          service.claim(id, { code: wrong(n) }),
        ),
      );

      const codes = results.map((r) =>
        r.status === 'rejected' ? (r.reason as ApiError).code : 'claimed',
      );
      expect(codes).not.toContain('claimed');
      expect(
        codes.filter((c) => c === ApiErrorCode.EasyRecoveryCodeInvalid).length,
      ).toBeLessThanOrEqual(EASY_RECOVERY_MAX_ATTEMPTS - 1);
      expect(codes).toContain(ApiErrorCode.EasyRecoveryBurned);
      // Every other guess found the counter already at the limit.
      for (const code of codes) {
        expect([
          ApiErrorCode.EasyRecoveryCodeInvalid,
          ApiErrorCode.EasyRecoveryBurned,
          ApiErrorCode.EasyRecoveryNotFound,
        ]).toContain(code);
      }
      expect(table.maxAttempts()).toBeLessThanOrEqual(
        EASY_RECOVERY_MAX_ATTEMPTS,
      );
      expect(table.rows.has(id)).toBe(false);
    });

    // The fake runs statements in arrival order, so guess #n lands behind n others.
    it.each([0, 1, 2, 3, 4])(
      'accepts the right code racing as guess #%i, behind fewer than five wrong ones',
      async (position) => {
        const { service, table } = build();
        const id = await offeredSession(service);
        const guesses = Array.from({ length: 12 }, (_, n) => wrong(n));
        guesses.splice(position, 0, CODE);

        const results = await Promise.allSettled(
          guesses.map((code) => service.claim(id, { code })),
        );

        expect(results[position]).toEqual({
          status: 'fulfilled',
          value: { ciphertext: CIPHERTEXT },
        });
        const codes = results
          .filter((r) => r.status === 'rejected')
          .map((r) => (r.reason as ApiError).code);
        // A claimed session is never also burned.
        expect(codes).not.toContain(ApiErrorCode.EasyRecoveryBurned);
        expect(table.rows.get(id)!.status).toBe(EasyRecoveryStatus.CLAIMED);
        expect(table.rows.get(id)!.ciphertext).toBeNull();
        expect(table.maxAttempts()).toBeLessThan(EASY_RECOVERY_MAX_ATTEMPTS);
      },
    );

    it.each([5, 6, 11])(
      'refuses the right code racing as guess #%i, behind five wrong ones',
      async (position) => {
        const { service, table } = build();
        const id = await offeredSession(service);
        const guesses = Array.from({ length: 12 }, (_, n) => wrong(n));
        guesses.splice(position, 0, CODE);

        const results = await Promise.allSettled(
          guesses.map((code) => service.claim(id, { code })),
        );

        expect(results.some((r) => r.status === 'fulfilled')).toBe(false);
        expect(table.rows.has(id)).toBe(false);
        expect(table.maxAttempts()).toBe(EASY_RECOVERY_MAX_ATTEMPTS);
      },
    );
  });
});
