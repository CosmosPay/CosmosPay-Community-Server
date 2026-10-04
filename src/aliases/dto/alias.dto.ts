import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { AliasChallengePurpose } from '@generated/prisma/client';
import { ALIAS_MAX_LENGTH, ALIAS_MIN_LENGTH } from '@/aliases/alias-name';
import { ALIAS_PAGE_SIZE } from '@/aliases/aliases.constants';
import { CHAINS, type Chain } from '@/chains/chains.constants';
import { IsChainAddress } from '@/common/validators/is-chain-address.validator';

/** The purposes a client may ask for. `RECOVER` is issued by the recovery flow. */
export const ALIAS_CLIENT_PURPOSES = ['CLAIM', 'ADD_ADDRESS', 'RECOVER'];

/**
 * The `chain` an address is on, on every request that names one. Omit it for
 * Stellar — every client written before Solana and Monad keeps working.
 */
function ChainField(): PropertyDecorator {
  return (target, key) => {
    ApiPropertyOptional({
      enum: CHAINS,
      default: 'stellar',
      description:
        'Chain the address is on. Omit for Stellar. Stellar signs the ' +
        'challenge digest (ed25519); Solana signs the challenge text (ed25519, ' +
        '`signMessage`); Monad signs it with EIP-191 `personal_sign`.',
    })(target, key);
    IsOptional()(target, key);
    IsIn(CHAINS)(target, key);
  };
}

export class CreateAliasChallengeDto {
  @ApiProperty({
    example: 'emanuel250',
    description: 'The handle being claimed.',
  })
  @IsString()
  @MinLength(ALIAS_MIN_LENGTH)
  @MaxLength(ALIAS_MAX_LENGTH)
  name!: string;

  @ChainField()
  chain?: Chain;

  @ApiProperty({
    description:
      'The address on `chain`: Stellar G…, Solana base58, Monad 0x….',
    example: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  })
  @IsString()
  @IsChainAddress('chain')
  address!: string;

  @ApiProperty({
    example: 'public',
    description: 'Network id: public | testnet | a custom id.',
  })
  @IsString()
  @MaxLength(40)
  network!: string;

  @ApiPropertyOptional({ enum: ALIAS_CLIENT_PURPOSES, default: 'CLAIM' })
  @IsOptional()
  @IsIn(ALIAS_CLIENT_PURPOSES)
  purpose?: AliasChallengePurpose;
}

export class ClaimAliasDto {
  @ApiProperty({ example: 'emanuel250' })
  @IsString()
  @MinLength(ALIAS_MIN_LENGTH)
  @MaxLength(ALIAS_MAX_LENGTH)
  name!: string;

  @ApiProperty({
    description:
      'Recovery mailbox. Required at claim time, not later: an alias whose owner ' +
      'loses their key before adding one is unrecoverable, and that is the state ' +
      'this field exists to prevent.',
    example: 'someone@example.com',
  })
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ description: 'The nonce from POST /v1/aliases/challenges.' })
  @IsString()
  @MaxLength(128)
  nonce!: string;

  @ApiProperty({
    description:
      'Stellar: base64 ed25519 over the challenge digest. Solana: base64 or ' +
      'base58 ed25519 over the challenge text. Monad: 0x-hex EIP-191 ' +
      'signature over the challenge text.',
  })
  @IsString()
  @MaxLength(200)
  signature!: string;

  @ApiPropertyOptional({
    description: 'Human label for this first address.',
    example: 'phone',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;
}

export class AddAliasAddressDto {
  @ChainField()
  chain?: Chain;

  @ApiProperty({
    description:
      'The address on `chain`: Stellar G…, Solana base58, Monad 0x….',
  })
  @IsString()
  @IsChainAddress('chain')
  address!: string;

  @ApiProperty({ example: 'testnet' })
  @IsString()
  @MaxLength(40)
  network!: string;

  @ApiProperty({ description: 'The nonce from an ADD_ADDRESS challenge.' })
  @IsString()
  @MaxLength(128)
  nonce!: string;

  @ApiProperty({
    description:
      'Stellar: base64 ed25519 over the challenge digest. Solana: base64 or ' +
      'base58 ed25519 over the challenge text. Monad: 0x-hex EIP-191 ' +
      'signature over the challenge text.',
  })
  @IsString()
  @MaxLength(200)
  signature!: string;

  @ApiPropertyOptional({ example: 'cold wallet' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  @ApiPropertyOptional({
    description:
      'Make this the address a payer gets when they do not ask for a specific ' +
      'one on this network. Exactly one address per network is primary.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  primary?: boolean;
}

export class StartAliasRecoveryDto {
  @ApiProperty({
    description:
      'The mailbox on record. Checked but never echoed: the response is identical ' +
      'whether or not it matched, so this endpoint cannot be used to ask which ' +
      'address owns a handle.',
    example: 'someone@example.com',
  })
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

export class CompleteAliasRecoveryDto {
  @ApiProperty({ description: 'The token delivered by email.' })
  @IsString()
  @MaxLength(200)
  token!: string;

  @ChainField()
  chain?: Chain;

  @ApiProperty({
    description:
      'The address that will own the alias from now on, on `chain`: Stellar ' +
      'G…, Solana base58, Monad 0x….',
  })
  @IsString()
  @IsChainAddress('chain')
  address!: string;

  @ApiProperty({ example: 'public' })
  @IsString()
  @MaxLength(40)
  network!: string;

  @ApiProperty({ description: 'The nonce from a RECOVER challenge.' })
  @IsString()
  @MaxLength(128)
  nonce!: string;

  @ApiProperty({
    description:
      'Stellar: base64 ed25519 over the challenge digest. Solana: base64 or ' +
      'base58 ed25519 over the challenge text. Monad: 0x-hex EIP-191 ' +
      'signature over the challenge text.',
  })
  @IsString()
  @MaxLength(200)
  signature!: string;
}

export class QueryAliasesDto {
  @ApiPropertyOptional({ default: ALIAS_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ALIAS_PAGE_SIZE)
  take: number = ALIAS_PAGE_SIZE;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;
}
