import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Owner/admin kill-switch for a fiat account (receiver): `disabled: true` blocks all
 * onramp/offramp use of it; `false` re-enables it. Independent of the KYC status.
 */
@ApiSchema({
  description:
    "The receiver's fiat-access kill-switch for onramp and offramp, independent of its KYC status.",
})
export class SetAccessDto {
  @ApiProperty({
    example: true,
    description: 'true = disable the fiat account, false = enable.',
  })
  @IsBoolean()
  disabled!: boolean;
}
