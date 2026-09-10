import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  AliasChallengePurpose,
  AliasStatus,
  Prisma,
} from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { PrismaService } from '@/prisma/prisma.service';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import {
  ALIAS_CHALLENGE_TTL_MS,
  ALIAS_MAX_ADDRESSES,
  ALIAS_MAX_PER_CONSUMER,
  ALIAS_RECOVERY_MAX_ATTEMPTS,
  ALIAS_RECOVERY_TTL_MS,
} from '@/aliases/aliases.constants';
import {
  aliasNameErrorMessage,
  normalizeAliasEmail,
  normalizeAliasName,
  validateAliasName,
} from '@/aliases/alias-name';
import {
  ALIAS_SIGN_DOMAIN,
  aliasChallengeMessage,
  verifyAliasSignature,
} from '@/aliases/alias-signing';
import {
  AddAliasAddressDto,
  ClaimAliasDto,
  CompleteAliasRecoveryDto,
  CreateAliasChallengeDto,
  QueryAliasesDto,
  StartAliasRecoveryDto,
} from '@/aliases/dto/alias.dto';

/** Columns safe to hand a stranger. Everything absent here is absent on purpose. */
const PUBLIC_ADDRESS_SELECT = {
  id: true,
  address: true,
  network: true,
  label: true,
  isPrimary: true,
  verifiedAt: true,
} as const;

/**
 * Claimable payment handles.
 *
 * The one thing to hold on to while reading this file: an alias is what a payer
 * reads immediately before authorising a transfer. Every rule below exists
 * because getting it wrong does not produce a bad row, it produces a payment to
 * the wrong account under a name the payer trusted.
 */
@Injectable()
export class AliasesService {
  private readonly logger = new Logger(AliasesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
  ) {}

  /* ------------------------------ challenges ------------------------------ */

  /**
   * Issue a nonce for the caller to sign.
   *
   * Issuing one reserves nothing. It deliberately does NOT check whether the name
   * is free, because a challenge endpoint that answered "taken" would be a
   * cheaper, unauthenticated way to enumerate the namespace than the availability
   * endpoint that is designed for it — and the claim is where the race is settled
   * anyway, by a unique index rather than by a check.
   */
  async createChallenge(
    consumer: GatewayConsumer,
    dto: CreateAliasChallengeDto,
  ) {
    const name = normalizeAliasName(dto.name);
    const nameError = validateAliasName(name);
    if (nameError) {
      throw ApiError.badRequest(
        ApiErrorCode.AliasNameInvalid,
        aliasNameErrorMessage(nameError),
      );
    }

    const purpose = dto.purpose ?? AliasChallengePurpose.CLAIM;
    // A challenge for an EXISTING alias is bound to it, so a nonce minted while
    // the handle was free cannot be spent after someone else claimed it.
    const alias =
      purpose === AliasChallengePurpose.CLAIM
        ? null
        : await this.prisma.alias.findUnique({ where: { name } });
    if (purpose !== AliasChallengePurpose.CLAIM && !alias) {
      throw ApiError.notFound(`No alias named "${name}".`);
    }

    const nonce = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + ALIAS_CHALLENGE_TTL_MS);

    await this.prisma.aliasChallenge.create({
      data: {
        aliasId: alias?.id ?? null,
        purpose,
        name,
        address: dto.address,
        network: dto.network,
        nonce,
        expiresAt,
      },
    });

    const message = aliasChallengeMessage({
      purpose,
      name,
      address: dto.address,
      network: dto.network,
      nonce,
    });

    // The message is RETURNED, not described. A client that rebuilds it from the
    // docs is one field-order change away from producing signatures this service
    // will reject, with nothing on either side saying why.
    return { nonce, message, domain: ALIAS_SIGN_DOMAIN, purpose, expiresAt };
  }

  /**
   * Spend a challenge: check it exists, matches, has not expired and has not been
   * used, then verify the signature over it.
   *
   * Consumption happens in the same `updateMany` that checks `consumedAt IS NULL`,
   * so two requests arriving together cannot both spend one nonce — the second
   * updates zero rows and is refused. A read-then-write would let both through,
   * and for `RECOVER` that is two owners for one handle.
   */
  private async spendChallenge(input: {
    nonce: string;
    purpose: AliasChallengePurpose;
    name: string;
    address: string;
    network: string;
    signature: string;
  }) {
    const challenge = await this.prisma.aliasChallenge.findUnique({
      where: { nonce: input.nonce },
    });

    const mismatched =
      !challenge ||
      challenge.purpose !== input.purpose ||
      challenge.name !== input.name ||
      challenge.address !== input.address ||
      challenge.network !== input.network ||
      challenge.consumedAt !== null ||
      challenge.expiresAt.getTime() <= Date.now();

    if (mismatched) {
      throw ApiError.badRequest(
        ApiErrorCode.AliasChallengeInvalid,
        'The challenge is unknown, expired, already used, or was issued for different details.',
      );
    }

    // Verified BEFORE consuming. Consuming first would let anyone burn a rival's
    // in-flight challenge by replaying its nonce with a junk signature.
    const ok = verifyAliasSignature(
      {
        purpose: input.purpose,
        name: input.name,
        address: input.address,
        network: input.network,
        nonce: input.nonce,
      },
      input.signature,
    );
    if (!ok) {
      throw ApiError.badRequest(
        ApiErrorCode.AliasSignatureInvalid,
        'The signature does not verify against the address that is claiming.',
      );
    }

    const spent = await this.prisma.aliasChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (spent.count !== 1) {
      throw ApiError.badRequest(
        ApiErrorCode.AliasChallengeInvalid,
        'The challenge was already used.',
      );
    }

    return challenge;
  }

  /* -------------------------------- claiming ------------------------------- */

  /**
   * Claim a handle.
   *
   * Two things settle the race, and neither is a pre-check: the unique index on
   * `alias.name`, and the single-use challenge. A `findUnique` before the insert
   * would be a TOCTOU window on the one operation where losing it means the wrong
   * person owns a name permanently — so the insert simply runs and `P2002` is the
   * answer.
   */
  async claim(consumer: GatewayConsumer, dto: ClaimAliasDto) {
    const local = await this.consumers.resolve(consumer);
    const name = normalizeAliasName(dto.name);
    const nameError = validateAliasName(name);
    if (nameError) {
      throw ApiError.badRequest(
        ApiErrorCode.AliasNameInvalid,
        aliasNameErrorMessage(nameError),
      );
    }

    const held = await this.prisma.alias.count({
      where: { consumerId: local.id },
    });
    if (held >= ALIAS_MAX_PER_CONSUMER) {
      throw ApiError.badRequest(
        ApiErrorCode.AliasAddressConflict,
        `An account may hold at most ${ALIAS_MAX_PER_CONSUMER} aliases.`,
      );
    }

    // The address and network come from the CHALLENGE, never from this request
    // body. The claim DTO has no address field at all for that reason: the
    // signature covers the challenge's copy, so a body field here would be a way
    // to sign for one address and register another.
    const { address, network } = await this.challengeCoordinates(dto.nonce);
    const challenge = await this.spendChallenge({
      nonce: dto.nonce,
      purpose: AliasChallengePurpose.CLAIM,
      name,
      address,
      network,
      signature: dto.signature,
    });

    try {
      const alias = await this.prisma.alias.create({
        data: {
          consumerId: local.id,
          name,
          displayName: dto.name.trim(),
          email: normalizeAliasEmail(dto.email),
          addresses: {
            create: {
              address: challenge.address,
              network: challenge.network,
              label: dto.label ?? null,
              // The first address on a network is necessarily its default.
              isPrimary: true,
            },
          },
        },
        include: { addresses: { select: PUBLIC_ADDRESS_SELECT } },
      });
      this.logger.log(
        `Alias "${name}" claimed by ${challenge.address} (${challenge.network})`,
      );
      return this.ownedView(alias);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw ApiError.conflict(
          ApiErrorCode.AliasTaken,
          `The alias "${name}" is already claimed.`,
        );
      }
      throw e;
    }
  }

  /**
   * The address/network a nonce was issued for.
   *
   * Read separately so {@link claim} can pass the challenge's own coordinates into
   * {@link spendChallenge} rather than the request body's. It costs one extra read
   * and removes the class of bug where a caller signs for one address and
   * registers another.
   */
  private async challengeCoordinates(nonce: string) {
    const row = await this.prisma.aliasChallenge.findUnique({
      where: { nonce },
      select: { address: true, network: true },
    });
    if (!row) {
      throw ApiError.badRequest(
        ApiErrorCode.AliasChallengeInvalid,
        'The challenge is unknown or expired.',
      );
    }
    return { address: row.address, network: row.network };
  }

  /* ------------------------------- addresses ------------------------------- */

  /**
   * Point an existing alias at another address.
   *
   * TWO proofs are required and they are different proofs: the caller must own the
   * alias (the gateway consumer matches), and the NEW address must sign for
   * itself. Owning the alias alone would let someone list an address they do not
   * control — harmless until the day it is used to make a stranger's account look
   * endorsed by a name people trust.
   */
  async addAddress(
    consumer: GatewayConsumer,
    name: string,
    dto: AddAliasAddressDto,
  ) {
    const alias = await this.requireOwned(consumer, name);

    const count = await this.prisma.aliasAddress.count({
      where: { aliasId: alias.id },
    });
    if (count >= ALIAS_MAX_ADDRESSES) {
      throw ApiError.badRequest(
        ApiErrorCode.AliasAddressConflict,
        `An alias may point at most ${ALIAS_MAX_ADDRESSES} addresses.`,
      );
    }

    await this.spendChallenge({
      nonce: dto.nonce,
      purpose: AliasChallengePurpose.ADD_ADDRESS,
      name: alias.name,
      address: dto.address,
      network: dto.network,
      signature: dto.signature,
    });

    // First address on a network is its default whether or not the caller asked;
    // otherwise `primary` decides. Done inside a transaction with the demotion so
    // the partial unique index can never see two primaries at once.
    const existingOnNetwork = await this.prisma.aliasAddress.count({
      where: { aliasId: alias.id, network: dto.network },
    });
    const primary = existingOnNetwork === 0 || dto.primary === true;

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (primary) {
          await tx.aliasAddress.updateMany({
            where: { aliasId: alias.id, network: dto.network, isPrimary: true },
            data: { isPrimary: false },
          });
        }
        return tx.aliasAddress.create({
          data: {
            aliasId: alias.id,
            address: dto.address,
            network: dto.network,
            label: dto.label ?? null,
            isPrimary: primary,
          },
          select: PUBLIC_ADDRESS_SELECT,
        });
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw ApiError.conflict(
          ApiErrorCode.AliasAddressConflict,
          'That address is already on this alias for that network.',
        );
      }
      throw e;
    }
  }

  /**
   * Remove an address.
   *
   * Removing the last address on a network is allowed; removing the last address
   * ANYWHERE is not. An alias resolving to nothing is a handle that still looks
   * claimed and answers every payer with an empty list — worse than either owning
   * it or releasing it.
   */
  async removeAddress(
    consumer: GatewayConsumer,
    name: string,
    addressId: string,
  ) {
    const alias = await this.requireOwned(consumer, name);
    const row = await this.prisma.aliasAddress.findFirst({
      where: { id: addressId, aliasId: alias.id },
    });
    if (!row) throw ApiError.notFound('No such address on this alias.');

    const total = await this.prisma.aliasAddress.count({
      where: { aliasId: alias.id },
    });
    if (total <= 1) {
      throw ApiError.badRequest(
        ApiErrorCode.AliasAddressConflict,
        'An alias must keep at least one address. Release the alias instead.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.aliasAddress.delete({ where: { id: row.id } });
      // Promote a survivor, so the network never ends up with addresses and no
      // default — which would make `primaryAddress` null on an alias that plainly
      // has somewhere to send.
      if (row.isPrimary) {
        const next = await tx.aliasAddress.findFirst({
          where: { aliasId: alias.id, network: row.network },
          orderBy: { createdAt: 'asc' },
        });
        if (next) {
          await tx.aliasAddress.update({
            where: { id: next.id },
            data: { isPrimary: true },
          });
        }
      }
    });

    return { id: addressId, deleted: true };
  }

  /* ------------------------------- resolution ------------------------------ */

  /**
   * What a payer's wallet asks: "where does this name send?"
   *
   * Reachable with the shared public key, because a payer resolving a handle is
   * exactly the anonymous caller this endpoint is for — and the answer is a pure
   * function of the request, returning nothing about who is asking.
   *
   * A SUSPENDED alias resolves to nothing rather than to its addresses. A
   * suspension that still hands out an account is a suspension that does nothing
   * about the money.
   */
  async resolve(name: string, network?: string) {
    const normalized = normalizeAliasName(name);
    const alias = await this.prisma.alias.findUnique({
      where: { name: normalized },
      include: {
        addresses: {
          where: network ? { network } : undefined,
          select: PUBLIC_ADDRESS_SELECT,
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });

    if (!alias || alias.status !== AliasStatus.ACTIVE) {
      throw ApiError.notFound(`No alias named "${normalized}".`);
    }

    return {
      name: alias.name,
      displayName: alias.displayName,
      addresses: alias.addresses,
      primaryAddress: alias.addresses.find((a) => a.isPrimary)?.address ?? null,
    };
  }

  /** Which aliases point at an address? Public for the same reason resolution is. */
  async findByAddress(address: string, network?: string) {
    const rows = await this.prisma.aliasAddress.findMany({
      where: { address, ...(network ? { network } : {}) },
      include: {
        alias: { select: { name: true, displayName: true, status: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return {
      data: rows
        .filter((r) => r.alias.status === AliasStatus.ACTIVE)
        .map((r) => ({
          name: r.alias.name,
          displayName: r.alias.displayName,
          network: r.network,
          isPrimary: r.isPrimary,
        })),
    };
  }

  /** Is a handle claimable? Says WHY not, because "no" alone sends people guessing. */
  async availability(name: string) {
    const normalized = normalizeAliasName(name);
    const nameError = validateAliasName(normalized);
    if (nameError)
      return { name: normalized, available: false, reason: nameError };
    const taken = await this.prisma.alias.findUnique({
      where: { name: normalized },
      select: { id: true },
    });
    return {
      name: normalized,
      available: !taken,
      reason: taken ? 'taken' : null,
    };
  }

  /* -------------------------------- ownership ------------------------------ */

  async listOwned(consumer: GatewayConsumer, query: QueryAliasesDto) {
    const local = await this.consumers.resolve(consumer);
    const where = { consumerId: local.id };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.alias.findMany({
        where,
        include: {
          addresses: {
            select: PUBLIC_ADDRESS_SELECT,
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          },
        },
        orderBy: { createdAt: 'desc' },
        take: query.take,
        skip: query.skip,
      }),
      this.prisma.alias.count({ where }),
    ]);
    return {
      data: rows.map((r) => this.ownedView(r)),
      total,
      take: query.take,
      skip: query.skip,
    };
  }

  /** Release a handle back to the namespace. Cascades to its addresses. */
  async release(consumer: GatewayConsumer, name: string) {
    const alias = await this.requireOwned(consumer, name);
    await this.prisma.alias.delete({ where: { id: alias.id } });
    this.logger.log(`Alias "${alias.name}" released`);
    return { id: alias.id, deleted: true };
  }

  private async requireOwned(consumer: GatewayConsumer, name: string) {
    const local = await this.consumers.resolve(consumer);
    const normalized = normalizeAliasName(name);
    const alias = await this.prisma.alias.findUnique({
      where: { name: normalized },
    });
    // A 404 rather than a 403 when it belongs to someone else: "this exists but is
    // not yours" is an ownership oracle over a namespace anyone can read.
    if (!alias || alias.consumerId !== local.id) {
      throw ApiError.notFound(`No alias named "${normalized}".`);
    }
    return alias;
  }

  /* -------------------------------- recovery ------------------------------- */

  /**
   * Begin an email recovery.
   *
   * **The response is identical whether or not anything matched.** An alias is
   * public and its owner's mailbox is not, so an endpoint that answered "no such
   * alias" or "wrong email" differently would confirm which address owns a handle
   * to anyone who asked. The token is null in the negative case and the caller —
   * which sends the mail — simply has nothing to send.
   *
   * This service does NOT send email, matching the KYC terms-of-service flow: it
   * returns the token and the mailbox, and the platform delivers it. The plaintext
   * exists only in this response; what is stored is its SHA-256.
   */
  async startRecovery(name: string, dto: StartAliasRecoveryDto) {
    const normalized = normalizeAliasName(name);
    const email = normalizeAliasEmail(dto.email);
    const alias = await this.prisma.alias.findUnique({
      where: { name: normalized },
    });

    const nothingToDo =
      !alias ||
      alias.status !== AliasStatus.ACTIVE ||
      !emailMatches(alias.email, email);
    if (nothingToDo) {
      return { accepted: true, token: null, email: null, expiresAt: null };
    }

    // Any earlier recovery is burned. Two live tokens for one alias means the
    // older one keeps working after its owner started again because the first
    // email never arrived — which is the exact window an attacker wants.
    await this.prisma.aliasRecovery.updateMany({
      where: { aliasId: alias.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ALIAS_RECOVERY_TTL_MS);
    await this.prisma.aliasRecovery.create({
      data: {
        aliasId: alias.id,
        tokenHash: hashToken(token),
        email: alias.email,
        expiresAt,
      },
    });

    this.logger.log(`Recovery started for alias "${normalized}"`);
    return { accepted: true, token, email: alias.email, expiresAt };
  }

  /**
   * Finish a recovery: hand the alias to a new owner and a new address.
   *
   * The token proves the mailbox; the signature proves the new key. BOTH are
   * required, and requiring both is the point — a token alone would mean anyone
   * who reads the owner's email can redirect their payments, and a signature alone
   * would mean anyone at all can.
   *
   * The recovered alias keeps its name and its email and loses every previous
   * address. That is deliberate: recovery exists because the old keys are gone,
   * and leaving them resolvable would leave whoever holds them still receiving
   * money sent to this name.
   */
  async completeRecovery(
    consumer: GatewayConsumer,
    name: string,
    dto: CompleteAliasRecoveryDto,
  ) {
    const local = await this.consumers.resolve(consumer);
    const normalized = normalizeAliasName(name);
    const alias = await this.prisma.alias.findUnique({
      where: { name: normalized },
    });
    if (!alias) throw ApiError.notFound(`No alias named "${normalized}".`);

    const recovery = await this.prisma.aliasRecovery.findUnique({
      where: { tokenHash: hashToken(dto.token) },
    });

    const bad =
      !recovery ||
      recovery.aliasId !== alias.id ||
      recovery.consumedAt !== null ||
      recovery.expiresAt.getTime() <= Date.now() ||
      recovery.attempts >= ALIAS_RECOVERY_MAX_ATTEMPTS;

    if (bad) {
      // Count the attempt against the alias's live recovery when there is one, so
      // the ladder cannot be sidestepped by sending garbage tokens.
      await this.prisma.aliasRecovery.updateMany({
        where: { aliasId: alias.id, consumedAt: null },
        data: { attempts: { increment: 1 } },
      });
      throw ApiError.badRequest(
        ApiErrorCode.AliasRecoveryInvalid,
        'The recovery token is unknown, expired or already used.',
      );
    }

    // The signature is checked before the token is spent, for the same reason a
    // claim's is: otherwise a junk signature burns a real recovery.
    await this.spendChallenge({
      nonce: dto.nonce,
      purpose: AliasChallengePurpose.RECOVER,
      name: alias.name,
      address: dto.address,
      network: dto.network,
      signature: dto.signature,
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      const spent = await tx.aliasRecovery.updateMany({
        where: { id: recovery.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (spent.count !== 1) {
        throw ApiError.badRequest(
          ApiErrorCode.AliasRecoveryInvalid,
          'The recovery token was already used.',
        );
      }
      await tx.aliasAddress.deleteMany({ where: { aliasId: alias.id } });
      await tx.aliasAddress.create({
        data: {
          aliasId: alias.id,
          address: dto.address,
          network: dto.network,
          isPrimary: true,
        },
      });
      return tx.alias.update({
        where: { id: alias.id },
        data: { consumerId: local.id },
        include: {
          addresses: {
            select: PUBLIC_ADDRESS_SELECT,
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
          },
        },
      });
    });

    this.logger.warn(
      `Alias "${alias.name}" recovered to ${dto.address} (${dto.network}) — previous addresses dropped`,
    );
    return this.ownedView(updated);
  }

  /* --------------------------------- shaping ------------------------------- */

  private ownedView<
    T extends {
      id: string;
      name: string;
      displayName: string;
      email: string;
      emailVerifiedAt: Date | null;
      status: AliasStatus;
      createdAt: Date;
      addresses?: unknown;
    },
  >(alias: T) {
    return {
      id: alias.id,
      name: alias.name,
      displayName: alias.displayName,
      email: alias.email,
      emailVerifiedAt: alias.emailVerifiedAt,
      status: alias.status,
      addresses: alias.addresses ?? [],
      createdAt: alias.createdAt,
    };
  }
}

/** SHA-256 hex. What the recovery table stores instead of the token. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time email comparison.
 *
 * The values are already normalized, so this is not about correctness — it is that
 * a byte-by-byte early exit on the recovery path is a timing oracle for the
 * mailbox behind a public handle, which is the one secret this flow protects.
 */
function emailMatches(stored: string, provided: string): boolean {
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    const padded = Buffer.alloc(a.length);
    b.copy(padded);
    timingSafeEqual(a, padded);
    return false;
  }
  return timingSafeEqual(a, b);
}
