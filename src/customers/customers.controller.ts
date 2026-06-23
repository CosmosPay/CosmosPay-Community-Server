import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentConsumer } from '../common/decorators/current-consumer.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '../common/interfaces/gateway-consumer.interface';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CustomersService } from './customers.service';

// URI versioning => /v1/customers
@ApiTags('customers')
@Controller({ path: 'customers', version: '1' })
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  @RequirePermissions('customers:write')
  @ApiOperation({ summary: 'Create a customer' })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateCustomerDto,
  ) {
    return this.customers.create(consumer, dto);
  }

  @Get()
  @RequirePermissions('customers:read')
  @ApiOperation({ summary: "List the consumer's customers (with payment stats)" })
  findAll(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.customers.findAll(consumer);
  }

  @Get(':id')
  @RequirePermissions('customers:read')
  @ApiOperation({ summary: 'Get a customer by id' })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.customers.findOne(consumer, id);
  }

  @Patch(':id')
  @RequirePermissions('customers:write')
  @ApiOperation({ summary: 'Update a customer' })
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
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.customers.remove(consumer, id);
  }
}
