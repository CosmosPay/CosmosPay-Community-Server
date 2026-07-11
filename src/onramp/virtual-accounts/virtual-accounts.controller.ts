import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentConsumer } from '../../common/decorators/current-consumer.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '../../common/interfaces/gateway-consumer.interface';
import { VirtualAccountsService } from './virtual-accounts.service';
import { CreateVirtualAccountDto } from '../dto/create-virtual-account.dto';

// /v1/onramp/receivers/:receiverId/virtual-accounts
@ApiTags('onramp')
@Controller({
  path: 'onramp/receivers/:receiverId/virtual-accounts',
  version: '1',
})
export class VirtualAccountsController {
  constructor(private readonly virtualAccounts: VirtualAccountsService) {}

  @Post()
  @RequirePermissions('onramp:write')
  @ApiOperation({ summary: 'Create a virtual account for a receiver' })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
    @Body() dto: CreateVirtualAccountDto,
  ) {
    return this.virtualAccounts.create(consumer, receiverId, dto);
  }

  @Get()
  @RequirePermissions('onramp:read')
  @ApiOperation({ summary: "List a receiver's virtual accounts" })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
  ) {
    return this.virtualAccounts.findAll(consumer, receiverId);
  }
}
