import { ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { EVM_TX_ID_RE } from '@/payment-intents/payment-intents.constants';

/**
 * Hands back the signed transaction for a swap so the service can relay it.
 * Whatever comes back must be the transaction the service built — its hash
 * (Stellar), its message bytes (Solana) or its call (Monad) is checked against
 * the stored swap before anything is broadcast.
 *
 * A Monad swap may instead name the transaction its wallet already sent
 * (`txHash`): EVM browser wallets only send (`eth_sendTransaction`) and never
 * hand over the signed bytes, so the service reads that transaction from the
 * chain and checks the same call.
 */
@ApiSchema({
  description:
    'The swap transaction: `signedXdr` for a Stellar swap, ' +
    '`signedTransaction` for a Solana swap, and for a Monad swap either ' +
    '`signedTransaction` (this service broadcasts it) or `txHash` (the ' +
    'wallet already broadcast it). Whichever is sent, it must be the ' +
    'transaction built for this swap.',
})
export class SubmitSwapDto {
  @ApiPropertyOptional({
    description:
      'Stellar swaps: the signed transaction envelope (base64 XDR). Required ' +
      'unless signedTransaction or txHash is sent.',
    example: 'AAAAAgAAAABx…(signed base64 XDR)…AAAAAAAAAAA=',
  })
  // Required exactly as before whenever the Solana/Monad fields are absent, so
  // a Stellar caller that forgets it gets the message it always got.
  @ValidateIf(
    (o: SubmitSwapDto) =>
      o.signedTransaction === undefined && o.txHash === undefined,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  signedXdr?: string;

  @ApiPropertyOptional({
    description:
      'Solana and Monad swaps: the signed transaction, which this service ' +
      'broadcasts. Solana: base64 wire bytes of the VersionedTransaction; ' +
      'Monad: the 0x-hex raw EIP-1559 transaction (the eth_sendRawTransaction ' +
      'input). On Monad, send this or txHash, not both.',
    example: '0x02f8b1818f…',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100_000)
  signedTransaction?: string;

  @ApiPropertyOptional({
    description:
      'Monad swaps only: the hash of the swap transaction the wallet already ' +
      'broadcast, for wallets that send a transaction but never hand over ' +
      'its signed bytes (EVM browser wallets answer eth_sendTransaction with ' +
      'the hash alone). The service reads it from its Monad node and checks ' +
      'it is the call built for this swap (`to`, `input`, `value`), sent ' +
      "from the swap's source on chain 143, before anything about the swap " +
      'is answered; it then records it and the swap is SUBMITTED until the ' +
      'observer sees it settle. Not on the node yet: 400 ' +
      '`transaction_not_found`, nothing recorded, retry in a few seconds. ' +
      'The same hash again answers the swap as it is. The approval ' +
      'transaction is sent by the wallet first and never submitted here. A ' +
      'Solana swap takes signedTransaction.',
    example:
      '0x8f3b6a1c2d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8',
    pattern: EVM_TX_ID_RE.source,
  })
  @IsOptional()
  @IsString()
  @Matches(EVM_TX_ID_RE, {
    message: 'txHash must be a 0x-prefixed 32-byte hex transaction hash',
  })
  txHash?: string;
}
