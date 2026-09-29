import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import {
  ANY_TX_ID_RE,
  HEX_TX_ID_RE,
} from '@/payment-intents/payment-intents.constants';

/**
 * Hex transaction ids are lowercased before they are validated and stored —
 * Horizon and EVM nodes report them lowercase, and the (consumerId, txHash)
 * index compares bytes. A Solana signature is base58, which is case-sensitive,
 * and is left exactly as sent.
 */
export const lowercaseHexTxId = ({ value }: { value: unknown }) =>
  typeof value === 'string' && HEX_TX_ID_RE.test(value)
    ? value.toLowerCase()
    : value;

export class ValidatePaymentIntentDto {
  @ApiProperty({
    description:
      'The transaction to validate against this intent, in its chain’s own ' +
      'form: a Stellar hash (64 hex), a Solana signature (base58) or a Monad ' +
      'hash (0x + 64 hex). It must be the one the intent’s chain uses.',
    example: '3389e9f0d6b3e3f1c2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9',
  })
  @Transform(lowercaseHexTxId)
  @IsString()
  @Matches(ANY_TX_ID_RE, {
    message:
      'txHash must be a transaction id: 64 hex characters (Stellar), a base58 ' +
      'signature (Solana) or 0x + 64 hex characters (Monad)',
  })
  txHash!: string;
}
