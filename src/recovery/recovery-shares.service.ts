import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { normalizeEmail, type Actor } from '@/recovery/recovery-core';
import { RECOVERY_SHARE_BYTES } from '@/recovery/recovery.constants';
import { RecoveryService, SepError } from '@/recovery/recovery.service';

const notFound = () => new SepError('Not found.', HttpStatus.NOT_FOUND);

/** What a half's routes answer with — never the half, except to `get`. */
export interface ShareReceipt {
  address: string;
  updated_at: string;
}

/**
 * This server's half of a wallet backup's recovery key — a Cosmos extension
 * beside SEP-30, on the same two servers and the same proofs.
 *
 * SEP-30 recovers the ACCOUNT: the two servers co-sign a new key onto it, and
 * the old seed — with every address it derived on other chains — is gone. This
 * recovers the SEED. The wallet splits a random key in two, files one half with
 * each server, and seals the backup's data key under the whole; proving the
 * inbox to both servers gets both halves back, and the backup opens.
 *
 * Who may do what mirrors SEP-30 exactly:
 *
 *  - only the key holder (a SEP-10 token of THAT account) writes or deletes a
 *    half — an identity that could file one would be a way in, not a way back;
 *  - the key holder, or whoever proved the filed email to THIS server (its own
 *    identity token, from an OIDC ID token or its own emailed code), reads it;
 *  - absent and not-yours are the same 404, so a stolen inbox learns nothing
 *    about which accounts it could have recovered.
 *
 * One half proves nothing and opens nothing: it is uniformly random on its own.
 * That is what makes it safe to hand to the identity, and the reason there are
 * two servers — each must be convinced of the inbox on its own.
 */
@Injectable()
export class RecoverySharesService {
  private readonly logger = new Logger(RecoverySharesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recovery: RecoveryService,
  ) {}

  /** PUT — file (or replace) this server's half. The key holder only. */
  async put(
    authorization: string | undefined,
    address: string,
    share: string,
    email: string,
  ): Promise<ShareReceipt> {
    const rules = this.recovery.rules();
    const actor = this.recovery.actor(authorization);
    assertKeyHolder(actor, address);
    if (Buffer.from(share, 'base64').length !== RECOVERY_SHARE_BYTES) {
      throw new SepError(
        `share must be ${RECOVERY_SHARE_BYTES} bytes, base64.`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const row = await this.prisma.recoveryBackupShare.upsert({
      where: { role_address: { role: rules.role, address } },
      create: {
        role: rules.role,
        address,
        share,
        email: normalizeEmail(email),
      },
      // A re-sealed backup has a new key: the old half is replaced, never kept.
      update: { share, email: normalizeEmail(email) },
      select: { address: true, updatedAt: true },
    });
    return { address: row.address, updated_at: row.updatedAt.toISOString() };
  }

  /** GET — hand the half back to the key holder or to the proven inbox. */
  async get(
    authorization: string | undefined,
    address: string,
  ): Promise<{ address: string; share: string }> {
    const rules = this.recovery.rules();
    const actor = this.recovery.actor(authorization);
    const row = await this.prisma.recoveryBackupShare.findUnique({
      where: { role_address: { role: rules.role, address } },
      select: { address: true, share: true, email: true },
    });
    if (!row || !mayTake(actor, address, row.email)) throw notFound();
    this.logger.log(
      `recovery: released a backup share for ${address} as ${actor.kind}`,
    );
    return { address: row.address, share: row.share };
  }

  /** DELETE — forget the half. The key holder only. */
  async remove(
    authorization: string | undefined,
    address: string,
  ): Promise<{ address: string }> {
    const rules = this.recovery.rules();
    const actor = this.recovery.actor(authorization);
    assertKeyHolder(actor, address);
    const { count } = await this.prisma.recoveryBackupShare.deleteMany({
      where: { role: rules.role, address },
    });
    if (count === 0) throw notFound();
    return { address };
  }
}

function assertKeyHolder(actor: Actor, address: string): void {
  if (actor.kind !== 'address' || actor.address !== address) {
    throw new SepError(
      "This needs the account's own key.",
      HttpStatus.FORBIDDEN,
    );
  }
}

/** The key holder, or an identity token for the email the half was filed under. */
export function mayTake(actor: Actor, address: string, email: string): boolean {
  if (actor.kind === 'address') return actor.address === address;
  return actor.type === 'email' && actor.value === normalizeEmail(email);
}
