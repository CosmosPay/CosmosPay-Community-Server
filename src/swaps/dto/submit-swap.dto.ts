import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Hands back the signed transaction for a swap so the service can relay it.
 * Whatever comes back must be the transaction the service built — its hash
 * (Stellar), its message bytes (Solana) or its call (Monad) is checked against
 * the stored swap before anything is broadcast.
 */
export class SubmitSwapDto {
  @ApiPropertyOptional({
    description:
      'Stellar swaps: the signed transaction envelope (base64 XDR). Required ' +
      'unless signedTransaction is sent.',
    example: 'AAAAAgAAAABx…(signed base64 XDR)…AAAAAAAAAAA=',
  })
  // Required exactly as before whenever the Solana/Monad field is absent, so a
  // Stellar caller that forgets it gets the message it always got.
  @ValidateIf((o: SubmitSwapDto) => o.signedTransaction === undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  signedXdr?: string;

  @ApiPropertyOptional({
    description:
      'Solana and Monad swaps: the signed transaction — Solana: base64 wire ' +
      'bytes of the VersionedTransaction; Monad: the 0x-hex raw EIP-1559 ' +
      'transaction (the eth_sendRawTransaction input).',
    example: '0x02f8b1818f…',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  signedTransaction?: string;
}
