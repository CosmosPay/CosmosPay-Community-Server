import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Owner/admin kill-switch for a fiat account (receiver): `disabled: true` blocks all
 * onramp/offramp use of it; `false` re-enables it. Independent of the KYC status.
 */
export class SetAccessDto {
  @ApiProperty({
    example: true,
    description: 'true = disable the fiat account, false = enable.',
  })
  @IsBoolean()
  disabled!: boolean;
}
