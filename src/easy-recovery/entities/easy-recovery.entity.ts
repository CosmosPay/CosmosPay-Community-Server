import { ApiProperty } from '@nestjs/swagger';
import { EASY_RECOVERY_WIRE_STATUS } from '@/easy-recovery/easy-recovery-core';

/*
 * These shapes are a CONTRACT with the wallet, which is written against them.
 * None of them ever carries `receiverKey` or the code, and only the claim of the
 * right code carries the ciphertext.
 */

export class EasyRecoverySessionCreatedEntity {
  @ApiProperty({
    description:
      'The session id: 16 random bytes, base64url (22 characters). Put it in ' +
      'the QR next to `receiverKey`, and nothing else from here.',
    example: 'q2Z7rT0aV1bX9cD4eF6gHw',
  })
  id!: string;

  @ApiProperty({
    description: 'When the session stops answering, ISO 8601. Five minutes.',
    example: '2026-10-28T20:05:00.000Z',
  })
  expiresAt!: string;
}

export class EasyRecoverySessionStatusEntity {
  @ApiProperty({
    enum: Object.values(EASY_RECOVERY_WIRE_STATUS),
    description:
      '`open`: waiting for the old device. `offered`: the old device has ' +
      'sent the sealed wallet and shows the code, which the new device asks for ' +
      'it. `claimed`: the new device collected it; the old device can stop.',
    example: 'offered',
  })
  status!: string;

  @ApiProperty({
    description: 'When the session stops answering, ISO 8601.',
    example: '2026-10-28T20:05:00.000Z',
  })
  expiresAt!: string;
}

export class EasyRecoveryOfferedEntity {
  @ApiProperty({ enum: ['offered'] })
  status!: string;
}

export class EasyRecoveryClaimedEntity {
  @ApiProperty({
    description:
      'The sealed wallet exactly as the old device sent it, base64url. Open it ' +
      'with the private key of `receiverKey`. Handed out once: the session ' +
      'reads `claimed` from now on and no longer holds it.',
  })
  ciphertext!: string;
}
