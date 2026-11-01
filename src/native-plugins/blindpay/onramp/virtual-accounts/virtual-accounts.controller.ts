import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { WidePaginationQueryDto } from '@/common/dto/pagination.query.dto';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { VirtualAccountsService } from '@/native-plugins/blindpay/onramp/virtual-accounts/virtual-accounts.service';
import { CreateVirtualAccountDto } from '@/native-plugins/blindpay/onramp/dto/create-virtual-account.dto';

// /v1/onramp/receivers/:receiverId/virtual-accounts
@ApiTags('onramp')
@Controller({
  path: 'onramp/receivers/:receiverId/virtual-accounts',
  version: '1',
})
export class VirtualAccountsController {
  constructor(private readonly virtualAccounts: VirtualAccountsService) {}

  @Post()
  // The account number is issued by BlindPay.
  @ApiUpstream('BlindPay')
  @RequirePermissions('onramp:write')
  @ApiOperation({
    summary: 'Create a virtual account for a receiver',
    description:
      "Opens a virtual account at BlindPay: a bank account in the receiver's " +
      'name at `banking_partner` whose deposits are converted to `token` and ' +
      'sent to `blockchain_wallet_id`, a Cosmos Pay wallet id. The account is ' +
      'mirrored here and the mirrored row is the answer. A receiver or wallet ' +
      "that is not yours on your key's BlindPay instance is a 404, and the " +
      'answer is `403 account_disabled` when the receiver, or the receiver ' +
      'that owns the wallet, has its fiat access disabled.',
  })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
    @Body() dto: CreateVirtualAccountDto,
  ) {
    return this.virtualAccounts.create(consumer, receiverId, dto);
  }

  @Get()
  @RequirePermissions('onramp:read')
  @ApiOperation({
    summary: "List a receiver's virtual accounts",
    description:
      "Reads this service's mirror only (no BlindPay call), newest first. The " +
      "receiver must be yours on your key's BlindPay instance, or the answer " +
      'is 404. Paginated with `take` (default 100, max 100) and `skip`; ' +
      'answers `{ data, total, take, skip }`.',
  })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.virtualAccounts.findAll(consumer, receiverId, query);
  }
}
