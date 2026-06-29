import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '../../common/decorators/current-consumer.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '../../common/interfaces/gateway-consumer.interface';
import { BankAccountsService } from './bank-accounts.service';
import { CreateBankAccountDto } from './dto/create-bank-account.dto';
import { BankAccountEntity } from './entities/bank-account.entity';

// /v1/kyc/receivers/:receiverId/bank-accounts
@ApiTags('kyc')
@Controller({ path: 'kyc/receivers/:receiverId/bank-accounts', version: '1' })
export class BankAccountsController {
  constructor(private readonly bankAccounts: BankAccountsService) {}

  @Post()
  @RequirePermissions('kyc:write')
  @ApiOperation({ summary: 'Add a fiat bank account for a receiver' })
  @ApiCreatedResponse({ type: BankAccountEntity })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
    @Body() dto: CreateBankAccountDto,
  ) {
    return this.bankAccounts.create(consumer, receiverId, dto);
  }

  @Get()
  @RequirePermissions('kyc:read')
  @ApiOperation({ summary: "List a receiver's bank accounts" })
  @ApiOkResponse({ type: [BankAccountEntity] })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
  ) {
    return this.bankAccounts.findAll(consumer, receiverId);
  }

  @Delete(':id')
  @RequirePermissions('kyc:write')
  @ApiOperation({ summary: 'Delete a bank account' })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
    @Param('id') id: string,
  ) {
    return this.bankAccounts.remove(consumer, receiverId, id);
  }
}
