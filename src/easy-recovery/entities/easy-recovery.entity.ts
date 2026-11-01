import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { EASY_RECOVERY_WIRE_STATUS } from '@/easy-recovery/easy-recovery-core';

/*
 * These shapes are a CONTRACT with the wallet, which is written against them.
 * None of them ever carries `receiverKey` or the code, and only the claim of the
 * right code carries the ciphertext.
 */

@ApiSchema({
  description:
    'A new easy-recovery session: its id, for the QR, and when it expires.',
})
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

@ApiSchema({
  description: 'Where an easy-recovery session stands, polled by both devices.',
})
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

@ApiSchema({
  description:
    "Confirmation that the old device's sealed wallet was stored for the session.",
})
export class EasyRecoveryOfferedEntity {
  @ApiProperty({ enum: ['offered'], description: 'Always `offered`.' })
  status!: string;
}

@ApiSchema({
  description: 'The sealed wallet, handed out once to the right code.',
})
export class EasyRecoveryClaimedEntity {
  @ApiProperty({
    description:
      'The sealed wallet exactly as the old device sent it, base64url. Open it ' +
      'with the private key of `receiverKey`. Handed out once: the session ' +
      'reads `claimed` from now on and no longer holds it.',
  })
  ciphertext!: string;
}
