import { ApiProperty } from '@nestjs/swagger';

/** The result of funding a wallet's reserve. */
export class PollarActivationEntity {
  @ApiProperty({
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  })
  public_key!: string;

  @ApiProperty({
    description: 'XLM funded: 1 base reserve plus 0.5 per configured asset.',
    example: '1.5',
  })
  amount!: string;

  @ApiProperty({
    description:
      'False when the wallet was already funded. Activation is idempotent, so ' +
      'a repeat is reported rather than raised.',
    example: true,
  })
  activated!: boolean;
}

/** Acknowledgement of a trustline change, carrying Pollar's own result code. */
export class PollarTrustlineEntity {
  @ApiProperty({
    description: "Pollar's result code, e.g. SERVER_TRUSTLINES_ENABLED.",
    example: 'SERVER_TRUSTLINES_ENABLED',
  })
  code!: string;
}
