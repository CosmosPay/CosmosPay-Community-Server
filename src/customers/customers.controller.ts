import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  CustomerDeletedEntity,
  CustomerEntity,
  CustomerListEntity,
  CustomerWalletDeletedEntity,
  CustomerWalletEntity,
} from '@/customers/entities/customer.entity';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { CreateCustomerDto } from '@/customers/dto/create-customer.dto';
import { CustomerWalletDto } from '@/customers/dto/customer-wallet.dto';
import { QueryCustomersDto } from '@/customers/dto/query-customers.dto';
import { UpdateCustomerDto } from '@/customers/dto/update-customer.dto';
import { CustomersService } from '@/customers/customers.service';

// URI versioning => /v1/customers
@ApiTags('customers')
@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  @RequirePermissions('customers:write')
  @ApiOperation({
    summary: 'Create a customer',
    description:
      'A customer holds up to 20 `wallets` on Stellar, Solana or Monad (the ' +
      'deprecated `account` counts as one of them), and a wallet named twice ' +
      'counts once. Payments settled from any of them count toward ' +
      'the customer. A wallet another of your customers already holds is ' +
      '`409 customer_wallet_taken`.',
  })
  @ApiCreatedResponse({ type: CustomerEntity })
  @ApiErrorResponse({ status: 409, codes: [ApiErrorCode.CustomerWalletTaken] })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateCustomerDto,
  ) {
    return this.customers.create(consumer, dto);
  }

  @Get()
  @RequirePermissions('customers:read')
  @ApiOperation({
    summary: "List the consumer's customers (with payment stats)",
    description:
      'Newest first, as `{ data, total, take, skip }` with `take` up to 100 ' +
      '(default 100). Each customer carries `payments`, `succeeded` and the ' +
      'gross settled `total` (amounts added as numbers, whatever the asset) of ' +
      "the payment intents paid from its wallets, on the key's network only. The payer of a settled payment whose " +
      'wallet no customer holds is added automatically (`reference: auto`).',
  })
  @ApiOkResponse({ type: CustomerListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryCustomersDto,
  ) {
    return this.customers.findAll(consumer, query);
  }

  @Get(':id')
  @RequirePermissions('customers:read')
  @ApiOperation({
    summary: 'Get a customer by id',
    description:
      'The customer with its wallets, oldest first, and `account`, the ' +
      "deprecated first wallet's address. Payment stats are on the list only.",
  })
  @ApiOkResponse({ type: CustomerEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.customers.findOne(consumer, id);
  }

  @Patch(':id')
  @RequirePermissions('customers:write')
  @ApiOperation({
    summary: 'Update a customer',
    description:
      'Changes only the fields sent (`name`, `alias`, `note`, `email`, ' +
      '`reference`). The deprecated `account` edits the first wallet only: an ' +
      'address replaces or adds it, `null` removes it; other wallets change ' +
      'through `/v1/customers/{id}/wallets`. An address another of your ' +
      'customers holds is `409 customer_wallet_taken`.',
  })
  @ApiOkResponse({ type: CustomerEntity })
  @ApiErrorResponse({ status: 409, codes: [ApiErrorCode.CustomerWalletTaken] })
  update(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customers.update(consumer, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('customers:write')
  @ApiOperation({
    summary: 'Delete a customer',
    description:
      'Deletes the customer and its wallets. Payment intents are kept; a later ' +
      'settled payment from one of those wallets adds its payer back as an ' +
      'automatic customer.',
  })
  @ApiOkResponse({ type: CustomerDeletedEntity })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.customers.remove(consumer, id);
  }

  @Post(':id/wallets')
  @RequirePermissions('customers:write')
  @ApiOperation({
    summary: 'Add a wallet to a customer',
    description:
      'A customer holds any number of wallets (up to 20), on Stellar, Solana or Monad; ' +
      'payments paid from any of them count toward it. A wallet the customer already holds ' +
      'answers as it is.',
  })
  @ApiCreatedResponse({ type: CustomerWalletEntity })
  @ApiErrorResponse({ status: 409, codes: [ApiErrorCode.CustomerWalletTaken] })
  addWallet(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: CustomerWalletDto,
  ) {
    return this.customers.addWallet(consumer, id, dto);
  }

  @Delete(':id/wallets/:walletId')
  @RequirePermissions('customers:write')
  @ApiOperation({
    summary: 'Remove a wallet from a customer',
    description:
      'Payments from that address stop counting toward this customer, and a ' +
      'later settled payment from it adds it as a new automatic customer. A ' +
      "`walletId` that is not one of this customer's wallets is 404.",
  })
  @ApiOkResponse({ type: CustomerWalletDeletedEntity })
  removeWallet(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Param('walletId') walletId: string,
  ) {
    return this.customers.removeWallet(consumer, id, walletId);
  }
}
