import { verifyMessageSignature } from '@/chains/message-signature';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { StellarNetwork } from '@/config/configuration';
import {
  PROTECTED_PAYMENT_DISPUTE_CHALLENGE_TITLE,
  PROTECTED_PAYMENT_DISPUTE_CHALLENGE_TTL_MS,
} from '@/native-plugins/trustless-work/trustless-work.constants';

/**
 * The message a buyer signs to have the platform open a dispute on its behalf.
 *
 * Under `MERCHANT_RELEASES` the buyer holds no role in the contract, so the
 * platform key opens the dispute for it, and that freezes the merchant's money
 * and spends Cosmos Pay's XLM. The payment link's id is enough to read the
 * payment, never to do that: the request carries a signature by the buyer's
 * own key (the address the deploy bound) over this message.
 *
 * Fixed order, `key: value`, newline-separated, every line present. The first
 * line is this flow's own, so a signature made for a sign-in, a backup or an
 * alias claim is worth nothing here and the other way round, and no Stellar
 * transaction envelope begins with it. It is signed as raw UTF-8 bytes, the way
 * `verifyMessageSignature` checks a Stellar message (the wallet's
 * `signChallenge`), with the expiry inside the signed bytes: a signature seen
 * once stops working ten minutes later, and a dispute opens only once anyway.
 */
export function disputeChallengeMessage(fields: {
  protectedPaymentId: string;
  buyer: string;
  network: StellarNetwork;
  expiresAt: string;
}): string {
  return (
    `${PROTECTED_PAYMENT_DISPUTE_CHALLENGE_TITLE}\n` +
    `payment: ${fields.protectedPaymentId}\n` +
    `account: ${fields.buyer}\n` +
    `network: ${fields.network}\n` +
    `expires: ${fields.expiresAt}`
  );
}

/** A challenge to show the buyer: the message, valid until `expiresAt`. */
export function disputeChallenge(
  fields: {
    protectedPaymentId: string;
    buyer: string;
    network: StellarNetwork;
  },
  now: Date,
): { message: string; expiresAt: string } {
  const expiresAt = new Date(
    now.getTime() + PROTECTED_PAYMENT_DISPUTE_CHALLENGE_TTL_MS,
  ).toISOString();
  return {
    message: disputeChallengeMessage({ ...fields, expiresAt }),
    expiresAt,
  };
}

/**
 * Refuses (`400 protected_payment_signature_invalid`) unless `signature` is
 * the buyer's signature over the challenge for this payment, network and
 * `expiresAt`, and `expiresAt` is a time still ahead, at most
 * {@link PROTECTED_PAYMENT_DISPUTE_CHALLENGE_TTL_MS} away. Never throws
 * anything else: every input arrives from the wire.
 */
export function assertDisputeChallengeSigned(
  fields: {
    protectedPaymentId: string;
    buyer: string;
    network: StellarNetwork;
    expiresAt: string;
    signature: string;
  },
  now: Date,
): void {
  const expires = Date.parse(fields.expiresAt);
  if (
    !Number.isFinite(expires) ||
    new Date(expires).toISOString() !== fields.expiresAt
  ) {
    throw invalid(
      'expiresAt must be the ISO 8601 time the signed message names, as GET returned it',
    );
  }
  if (expires <= now.getTime()) {
    throw invalid('The signed message expired: sign a new one.');
  }
  if (expires > now.getTime() + PROTECTED_PAYMENT_DISPUTE_CHALLENGE_TTL_MS) {
    throw invalid('The signed message expires too far ahead: sign a new one.');
  }
  const message = disputeChallengeMessage(fields);
  if (
    !verifyMessageSignature('stellar', fields.buyer, message, fields.signature)
  ) {
    throw invalid(
      "The signature does not verify against the payment's buyer address.",
    );
  }
}

function invalid(message: string): ApiError {
  return ApiError.badRequest(
    ApiErrorCode.ProtectedPaymentSignatureInvalid,
    message,
  );
}
