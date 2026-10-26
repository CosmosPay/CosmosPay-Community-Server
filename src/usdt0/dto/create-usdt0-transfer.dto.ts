import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { IsDecimalAmount } from '@/common/validators/is-decimal-amount.validator';
import { IsStellarAddress } from '@/common/validators/is-stellar-address.validator';
import { USDT0_CHAIN_IDS, type Usdt0ChainId } from '@/usdt0/usdt0.constants';

/**
 * A USDT0 transfer from Stellar: the holder, the destination network, the EVM
 * recipient and the amount. The service builds the one Soroban transaction the
 * holder signs (`send` on the OFT) and never holds a key.
 */
export class CreateUsdt0TransferDto {
  @ApiProperty({
    example: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    description:
      'The Stellar account that holds the USDT0, signs the transaction and ' +
      'pays its fees in XLM (LayerZero fee plus network fee).',
  })
  @IsStellarAddress()
  source!: string;

  @ApiProperty({
    enum: USDT0_CHAIN_IDS,
    example: 'eth',
    description:
      'The destination network (`GET /v1/usdt0/routes`). `eth` receives ' +
      'native USDT; every other network receives USDT0.',
  })
  @IsIn(USDT0_CHAIN_IDS)
  to!: Usdt0ChainId;

  @ApiProperty({
    example: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    description:
      'The EVM address credited on the destination network (0x + 40 hex). A ' +
      'mixed-case address must carry a valid EIP-55 checksum.',
  })
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{40}$/, {
    message: 'recipient must be an EVM address (0x + 40 hex)',
  })
  recipient!: string;

  @ApiProperty({
    example: '12.5',
    description:
      'USDT0 to send, decimal with up to 7 places. The OFT carries 6: a 7th ' +
      'decimal is dust that stays in the account (see `dust`).',
  })
  @IsString()
  @IsDecimalAmount()
  amount!: string;

  @ApiPropertyOptional({
    example: 'usdt0-retry-2026-10-25-001',
    description:
      'Optional idempotency key. Prefer the `Idempotency-Key` request header; ' +
      'when both are set, the header wins. A retry with the same key and the ' +
      'same request returns the stored transfer; the same key with a ' +
      'different request is 409 `idempotency_conflict`.',
  })
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'idempotencyKey must not be blank' })
  idempotencyKey?: string;
}
