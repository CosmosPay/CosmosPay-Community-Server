import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { IsAnyChainAddress } from '@/common/validators/is-any-chain-address.validator';
import { CreateCustomerDto } from '@/customers/dto/create-customer.dto';

/**
 * The customer's own fields. Wallets have their own routes (`POST` and `DELETE
 * /v1/customers/{id}/wallets`); `account` keeps the meaning it had when a customer held one
 * address, so a client written then still edits that address.
 */
export class UpdateCustomerDto extends PartialType(
  OmitType(CreateCustomerDto, ['wallets', 'account'] as const),
) {
  @ApiPropertyOptional({
    nullable: true,
    deprecated: true,
    description:
      'Deprecated: manage wallets with `POST` and `DELETE /v1/customers/{id}/wallets`. The ' +
      "customer's first wallet: an address replaces it (or adds one), its chain read from " +
      'its shape; null removes it.',
  })
  @IsOptional()
  @IsAnyChainAddress()
  account?: string | null;
}
