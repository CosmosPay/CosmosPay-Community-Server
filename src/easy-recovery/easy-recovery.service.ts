import { Injectable } from '@nestjs/common';
import { EasyRecoveryStatus } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { PrismaService } from '@/prisma/prisma.service';
import {
  CreateEasyRecoverySessionDto,
  ClaimEasyRecoveryDto,
  OfferEasyRecoveryDto,
} from '@/easy-recovery/dto/easy-recovery.dto';
import {
  EASY_RECOVERY_WIRE_STATUS,
  easyRecoveryCodeHash,
  easyRecoveryCodeMatches,
  isLiveSession,
  isSessionId,
  newSessionId,
} from '@/easy-recovery/easy-recovery-core';
import {
  EASY_RECOVERY_MAX_ATTEMPTS,
  EASY_RECOVERY_TTL_MS,
} from '@/easy-recovery/easy-recovery.constants';
import type {
  EasyRecoveryClaimedEntity,
  EasyRecoveryOfferedEntity,
  EasyRecoverySessionCreatedEntity,
  EasyRecoverySessionStatusEntity,
} from '@/easy-recovery/entities/easy-recovery.entity';

/**
 * What a status read may select: never `receiverKey`, `ciphertext` or
 * `codeHash`, so no later edit to the response can leak one by accident.
 */
const EASY_RECOVERY_STATUS_SELECT = {
  status: true,
  attempts: true,
  expiresAt: true,
} as const;

/** What a claim needs to decide, and the sealed secret it may hand out. */
const EASY_RECOVERY_CLAIM_SELECT = {
  status: true,
  attempts: true,
  expiresAt: true,
  ciphertext: true,
  codeHash: true,
} as const;

/**
 * Easy recovery: moving a wallet from an OLD device to a NEW one through a
 * mailbox that lives five minutes.
 *
 *  1. The new device opens a session with its X25519 public key and shows a QR
 *     holding the session id and that key.
 *  2. The old device scans it, seals the wallet to that key on the device, and
 *     offers the sealed wallet here with a five-digit code it shows on screen.
 *  3. The person types the code on the new device, which claims the sealed
 *     wallet and opens it locally.
 *
 * This service never sees the wallet: it never holds the private half of the
 * receiving key. What it adds is the code. A phishing page that shows its OWN
 * QR holds that private half, so the sealed wallet is readable to it — but only
 * once it has the code, which is on the victim's screen. That is why the three
 * rules here are the security of the feature, and each is enforced by a
 * conditional write rather than by a read followed by a write:
 *
 *  - **one offer**: the first offer moves `OPEN → OFFERED`; any other finds no
 *    `OPEN` row to move;
 *  - **five wrong codes**: each wrong code is counted by an update that only
 *    matches below the limit, the right code is accepted by one that only
 *    matches below it too, and the fifth wrong one deletes the row;
 *  - **five minutes**: every write is conditional on `expiresAt` too, and a
 *    read past it is the 404 of a session that never existed.
 *
 * Several replicas serve these routes, so all of it is rows in Postgres; nothing
 * is kept in memory.
 */
@Injectable()
export class EasyRecoveryService {
  constructor(private readonly prisma: PrismaService) {}

  /** `POST /sessions` — the new device opens a session. */
  async createSession(
    dto: CreateEasyRecoverySessionDto,
  ): Promise<EasyRecoverySessionCreatedEntity> {
    const id = newSessionId();
    const expiresAt = new Date(Date.now() + EASY_RECOVERY_TTL_MS);
    await this.prisma.easyRecoverySession.create({
      data: { id, receiverKey: dto.receiverKey, expiresAt },
      select: { id: true },
    });
    return { id, expiresAt: expiresAt.toISOString() };
  }

  /** `GET /sessions/{id}` — both devices poll it. Never returns a secret. */
  async status(id: string): Promise<EasyRecoverySessionStatusEntity> {
    const row = await this.findLive(id, new Date());
    return {
      status: EASY_RECOVERY_WIRE_STATUS[row.status],
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  /**
   * `POST /sessions/{id}/offer` — the old device leaves the sealed wallet and
   * the hash of the code it shows.
   *
   * One conditional update decides it: only an `OPEN`, unexpired row moves, so
   * of two offers racing for one session exactly one lands. The loser is told
   * whether the session is gone (404) or already holds an offer (409).
   */
  async offer(
    id: string,
    dto: OfferEasyRecoveryDto,
  ): Promise<EasyRecoveryOfferedEntity> {
    if (!isSessionId(id)) throw notFound();
    const now = new Date();

    const offered = await this.prisma.easyRecoverySession.updateMany({
      where: { id, status: EasyRecoveryStatus.OPEN, expiresAt: { gt: now } },
      data: {
        status: EasyRecoveryStatus.OFFERED,
        ciphertext: dto.ciphertext,
        codeHash: easyRecoveryCodeHash(id, dto.code),
      },
    });
    if (offered.count === 1) return { status: 'offered' };

    await this.findLive(id, now);
    throw ApiError.conflict(
      ApiErrorCode.EasyRecoveryAlreadyOffered,
      'This recovery session already holds an offer. Start again on the new device.',
    );
  }

  /**
   * `POST /sessions/{id}/claim` — the new device trades the code for the sealed
   * wallet, once.
   *
   * The code is compared in constant time against the stored hash, then:
   *
   *  - **right**: one update moves `OFFERED → CLAIMED` and wipes the ciphertext
   *    and the hash, only while the row is below the attempt limit and unexpired.
   *    Whoever's update matches is the one claim; a second right code finds no
   *    `OFFERED` row.
   *  - **wrong**: {@link refuseCode}.
   *
   * Comparing before counting does not hand a parallel guesser more than five
   * tries: every wrong guess is counted by an update that matches only below
   * the limit, and the right guess is accepted only by an update that matches
   * only below it too. However many guesses race, at most four wrong ones can
   * land before a right one is still accepted.
   */
  async claim(
    id: string,
    dto: ClaimEasyRecoveryDto,
  ): Promise<EasyRecoveryClaimedEntity> {
    if (!isSessionId(id)) throw notFound();
    const now = new Date();

    const row = await this.prisma.easyRecoverySession.findUnique({
      where: { id },
      select: EASY_RECOVERY_CLAIM_SELECT,
    });
    // A claimed session is a tombstone for the old device's poll, not something
    // a claim can still be answered from.
    if (!isLiveSession(row, now) || row.status === EasyRecoveryStatus.CLAIMED) {
      throw notFound();
    }
    if (row.status === EasyRecoveryStatus.OPEN) {
      throw ApiError.conflict(
        ApiErrorCode.EasyRecoveryNotOffered,
        'Nothing has been offered on this session yet. Confirm on the other device first.',
      );
    }
    // An OFFERED row always holds both; a row without them is not one to claim.
    if (row.ciphertext === null || row.codeHash === null) throw notFound();

    if (!easyRecoveryCodeMatches(id, dto.code, row.codeHash)) {
      return this.refuseCode(id, now);
    }

    const claimed = await this.prisma.easyRecoverySession.updateMany({
      where: {
        id,
        status: EasyRecoveryStatus.OFFERED,
        attempts: { lt: EASY_RECOVERY_MAX_ATTEMPTS },
        expiresAt: { gt: now },
      },
      data: {
        status: EasyRecoveryStatus.CLAIMED,
        ciphertext: null,
        codeHash: null,
      },
    });
    // Another request claimed it, burned it, or the clock ran out in between.
    if (claimed.count !== 1) throw notFound();

    // Read before the wipe; an OFFERED row's ciphertext never changes, so this
    // is exactly what the update just removed.
    return { ciphertext: row.ciphertext };
  }

  /**
   * Counts one wrong code, and deletes the session on the last one allowed.
   *
   * The increment matches only an `OFFERED`, unexpired row below the limit, so
   * concurrent wrong codes cannot carry the counter past it: Postgres re-checks
   * the condition on the row each update waits for. The count reported back is
   * read after the increment, so under a race it can only be lower than this
   * request's own, never higher.
   */
  private async refuseCode(id: string, now: Date): Promise<never> {
    const counted = await this.prisma.easyRecoverySession.updateMany({
      where: {
        id,
        status: EasyRecoveryStatus.OFFERED,
        attempts: { lt: EASY_RECOVERY_MAX_ATTEMPTS },
        expiresAt: { gt: now },
      },
      data: { attempts: { increment: 1 } },
    });
    // Claimed, burned or expired by a request that got there first.
    if (counted.count === 0) throw notFound();

    const after = await this.prisma.easyRecoverySession.findUnique({
      where: { id },
      select: { attempts: true },
    });
    // Gone already: a concurrent wrong code was the last one and deleted it.
    const attempts = after?.attempts ?? EASY_RECOVERY_MAX_ATTEMPTS;

    if (attempts >= EASY_RECOVERY_MAX_ATTEMPTS) {
      // The sealed wallet goes with the row. Conditional, so a row this request
      // did not exhaust is never deleted on its account.
      await this.prisma.easyRecoverySession.deleteMany({
        where: { id, attempts: { gte: EASY_RECOVERY_MAX_ATTEMPTS } },
      });
      throw ApiError.gone(
        ApiErrorCode.EasyRecoveryBurned,
        'Too many wrong codes: this recovery session was deleted. Start again on the new device.',
      );
    }

    throw ApiError.unprocessable(
      ApiErrorCode.EasyRecoveryCodeInvalid,
      'That code is not the one shown on the other device.',
      { attemptsLeft: EASY_RECOVERY_MAX_ATTEMPTS - attempts },
    );
  }

  /** The session's status columns, or the 404 of one that does not answer. */
  private async findLive(id: string, now: Date) {
    if (!isSessionId(id)) throw notFound();
    const row = await this.prisma.easyRecoverySession.findUnique({
      where: { id },
      select: EASY_RECOVERY_STATUS_SELECT,
    });
    if (!isLiveSession(row, now)) throw notFound();
    return row;
  }
}

/**
 * Unknown, expired, claimed (on a claim) and burned are one answer: none of them
 * changes what either device does next, which is to start again.
 */
function notFound(): ApiError {
  return ApiError.notFound(
    'This recovery session does not exist or has expired. Start again on the new device.',
    ApiErrorCode.EasyRecoveryNotFound,
  );
}
