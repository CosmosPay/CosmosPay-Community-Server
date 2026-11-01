import { ApiProperty, ApiSchema } from '@nestjs/swagger';

/**
 * The envelope a payment link with a merchant fee asks its payer to sign: the
 * payment to the merchant and the fee's, with the link's MEMO_ID, built for
 * one payer's account.
 */
@ApiSchema({
  description:
    'The unsigned Stellar envelope a payment link with a merchant fee asks its payer to sign, with its SEP-7 link and QR.',
})
export class PayerTransactionEntity {
  @ApiProperty({
    description:
      'The unsigned transaction envelope (base64 XDR): two payments, to the ' +
      'merchant and to the fee wallet, with the link’s MEMO_ID.',
    example: 'AAAAAgAAAAA...',
  })
  xdr!: string;

  @ApiProperty({
    description: 'The SEP-7 `web+stellar:tx` link a wallet opens to sign it.',
    example: 'web+stellar:tx?xdr=AAAAAgAAAAA...',
  })
  uri!: string;

  @ApiProperty({
    description: 'The QR of `uri`, as a PNG data URL.',
    example: 'data:image/png;base64,iVBORw0KGgo...',
  })
  qr!: string;
}
