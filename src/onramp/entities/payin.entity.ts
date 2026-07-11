import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Cosmos Pay view of a BlindPay payin (onramp, `pi_...`). */
export class PayinEntity {
  @ApiProperty({ example: 'clz9xpayin0001' })
  id!: string;

  @ApiProperty({ example: 'pi_000000000000' })
  blindpayId!: string;

  @ApiPropertyOptional({ example: 'processing' })
  status!: string | null;

  @ApiPropertyOptional({ example: 'USDC' })
  token!: string | null;

  @ApiPropertyOptional({ example: 'stellar' })
  network!: string | null;

  @ApiPropertyOptional({ example: 'pix' })
  paymentMethod!: string | null;

  @ApiPropertyOptional({ example: '10000' })
  senderAmount!: string | null;

  @ApiPropertyOptional({ example: '9950' })
  receiverAmount!: string | null;

  @ApiPropertyOptional({
    description:
      'Funding instructions for the payer (memo/CLABE/PIX/CBU/PSE/...).',
    example: { pix_code: '00020126...5204000053039865802BR...' },
  })
  instructions!: unknown;

  @ApiProperty({ example: '2026-06-28T12:00:00.000Z' })
  createdAt!: Date;
}
