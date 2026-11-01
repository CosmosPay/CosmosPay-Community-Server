import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiUpstream } from '@/common/decorators/api-upstream.decorator';
import { WidePaginationQueryDto } from '@/common/dto/pagination.query.dto';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { BankAccountsService } from '@/native-plugins/blindpay/kyc/bank-accounts/bank-accounts.service';
import { CreateBankAccountDto } from '@/native-plugins/blindpay/kyc/bank-accounts/dto/create-bank-account.dto';
import {
  BankAccountEntity,
  BankAccountListEntity,
  BankAccountDeletedEntity,
} from '@/native-plugins/blindpay/kyc/bank-accounts/entities/bank-account.entity';

// /v1/kyc/receivers/:receiverId/bank-accounts
@ApiTags('kyc')
@Controller({ path: 'kyc/receivers/:receiverId/bank-accounts', version: '1' })
export class BankAccountsController {
  constructor(private readonly bankAccounts: BankAccountsService) {}

  @Post()
  // The account is created at BlindPay; the row here is the mirror.
  @ApiUpstream('BlindPay')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary: 'Add a fiat bank account for a receiver',
    description:
      'Creates the account at BlindPay under the receiver and mirrors it; offramp payouts settle to it. ' +
      "`type` names the rail, and only that rail's fields are needed (`GET /v1/kyc/bank-details?rail=` lists them). " +
      'The response carries identifiers only (`rail`, `name`, `country`), never the account numbers. ' +
      'A disabled receiver is refused with 403 `account_disabled`.',
  })
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
  @ApiOperation({
    summary: "List a receiver's bank accounts",
    description:
      'Reads the local mirror, newest first; BlindPay is not called, and account numbers are never returned. ' +
      'Paginated with `take` (default 100, max 100) and `skip`; answers `{ data, total, take, skip }`.',
  })
  @ApiOkResponse({ type: BankAccountListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.bankAccounts.findAll(consumer, receiverId, query);
  }

  @Delete(':id')
  @ApiUpstream('BlindPay')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary: 'Delete a bank account',
    description:
      'Deletes the account at BlindPay, then its local row. ' +
      'An id this receiver does not have answers `deleted: true` without calling BlindPay, so repeating a delete succeeds.',
  })
  @ApiOkResponse({ type: BankAccountDeletedEntity })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
    @Param('id') id: string,
  ) {
    return this.bankAccounts.remove(consumer, receiverId, id);
  }
}
