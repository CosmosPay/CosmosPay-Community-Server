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
} from '@/customers/entities/customer.entity';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { CreateCustomerDto } from '@/customers/dto/create-customer.dto';
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
}
