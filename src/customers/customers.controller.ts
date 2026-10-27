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
  @ApiOperation({ summary: 'Create a customer' })
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
  @ApiOperation({ summary: 'Get a customer by id' })
  @ApiOkResponse({ type: CustomerEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.customers.findOne(consumer, id);
  }

  @Patch(':id')
  @RequirePermissions('customers:write')
  @ApiOperation({ summary: 'Update a customer' })
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
  @ApiOperation({ summary: 'Delete a customer' })
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
  @ApiOperation({ summary: 'Remove a wallet from a customer' })
  @ApiOkResponse({ type: CustomerWalletDeletedEntity })
  removeWallet(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Param('walletId') walletId: string,
  ) {
    return this.customers.removeWallet(consumer, id, walletId);
  }
}
