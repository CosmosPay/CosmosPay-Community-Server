import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  Matches,
  MaxLength,
  MinLength,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';
import { isReceiverKey } from '@/easy-recovery/easy-recovery-core';
import {
  BASE64URL_PATTERN,
  EASY_RECOVERY_CIPHERTEXT_MAX_CHARS,
  EASY_RECOVERY_CODE_PATTERN,
  EASY_RECOVERY_RECEIVER_KEY_CHARS,
} from '@/easy-recovery/easy-recovery.constants';

/**
 * `receiverKey` is an X25519 public key the new device could really hold
 * (`isReceiverKey`): refused as a 400 naming the field, before the database.
 */
function IsReceiverKey(options?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isReceiverKey',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => isReceiverKey(value),
        defaultMessage: () =>
          `${propertyName} must be a 32-byte X25519 public key, base64url ` +
          `without padding (${EASY_RECOVERY_RECEIVER_KEY_CHARS} characters), ` +
          'and not a low-order point',
      },
    });
  };
}

/** `POST /v1/wallet/easy-recovery/sessions` — the NEW device opens a session. */
export class CreateEasyRecoverySessionDto {
  @ApiProperty({
    description:
      'The new device’s X25519 public key: 32 bytes, base64url without ' +
      'padding (43 characters). Generate a fresh key pair for every session ' +
      'and keep the private half on the device. The old device seals the ' +
      'wallet to this key, so it reads it from the QR, never from this service.',
    example: 'E75P6uryBMf9M1j8nAByGIHRdCeBKCJ-xnTzf3_pe20',
    minLength: EASY_RECOVERY_RECEIVER_KEY_CHARS,
    maxLength: EASY_RECOVERY_RECEIVER_KEY_CHARS,
  })
  @IsString()
  @IsReceiverKey()
  receiverKey!: string;
}

/** `POST /v1/wallet/easy-recovery/sessions/{id}/offer` — the OLD device. */
export class OfferEasyRecoveryDto {
  @ApiProperty({
    description:
      'The wallet’s secret sealed on the old device to the session’s ' +
      '`receiverKey` (ECIES), base64url. This service stores it as given, ' +
      'cannot open it, and hands it out once, to the right code.',
    minLength: 1,
    maxLength: EASY_RECOVERY_CIPHERTEXT_MAX_CHARS,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(EASY_RECOVERY_CIPHERTEXT_MAX_CHARS)
  @Matches(BASE64URL_PATTERN, { message: 'ciphertext must be base64url' })
  ciphertext!: string;

  @ApiProperty({
    description:
      'The five-digit code the old device generated at random and shows on ' +
      'its own screen. Only its hash is stored.',
    example: '48213',
    pattern: EASY_RECOVERY_CODE_PATTERN.source,
  })
  @IsString()
  @Matches(EASY_RECOVERY_CODE_PATTERN, {
    message: 'code must be exactly five digits',
  })
  code!: string;
}

/** `POST /v1/wallet/easy-recovery/sessions/{id}/claim` — the NEW device. */
export class ClaimEasyRecoveryDto {
  @ApiProperty({
    description:
      'The five-digit code the person read off the old device. A malformed ' +
      'one is a 400 and costs no attempt; a wrong one costs one of five.',
    example: '48213',
    pattern: EASY_RECOVERY_CODE_PATTERN.source,
  })
  @IsString()
  @Matches(EASY_RECOVERY_CODE_PATTERN, {
    message: 'code must be exactly five digits',
  })
  code!: string;
}
