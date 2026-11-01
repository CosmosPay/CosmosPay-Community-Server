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
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { CreateProductDto } from '@/products/dto/create-product.dto';
import { QueryProductsDto } from '@/products/dto/query-products.dto';
import { UpdateProductDto } from '@/products/dto/update-product.dto';
import {
  ProductDeletedEntity,
  ProductEntity,
  ProductListEntity,
} from '@/products/entities/product.entity';
import { ProductsService } from '@/products/products.service';

// URI versioning => /v1/products
@ApiTags('products')
@Controller({ path: 'products', version: '1' })
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Post()
  @RequirePermissions('products:write')
  @ApiOperation({
    summary: 'Create a product',
    description:
      'A catalog record: `name`, an optional decimal `amount` (up to 7 ' +
      'decimals; omit for a customer-set price), `assetCode` (omitted, `XLM` ' +
      'or `native` store `native`), `kind` (`one_time` by default, ' +
      '`recurring` or `link`, informational) and `active` (default `true`). ' +
      'Creating one builds no payment link or intent.',
  })
  @ApiCreatedResponse({ type: ProductEntity })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreateProductDto,
  ) {
    return this.products.create(consumer, dto);
  }

  @Get()
  @RequirePermissions('products:read')
  @ApiOperation({
    summary: "List the consumer's products",
    description:
      'Newest first, as `{ data, total, take, skip }` with `take` up to 100 ' +
      '(default 100). Inactive products (`active: false`) are included.',
  })
  @ApiOkResponse({ type: ProductListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: QueryProductsDto,
  ) {
    return this.products.findAll(consumer, query);
  }

  @Get(':id')
  @RequirePermissions('products:read')
  @ApiOperation({
    summary: 'Get a product by id',
    description: 'One of the consumer’s products, active or not.',
  })
  @ApiOkResponse({ type: ProductEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.products.findOne(consumer, id);
  }

  @Patch(':id')
  @RequirePermissions('products:write')
  @ApiOperation({
    summary: 'Update a product',
    description:
      'Changes only the fields sent; `assetCode` is normalized as on create. ' +
      'Set `active: false` to retire a product and keep its record.',
  })
  @ApiOkResponse({ type: ProductEntity })
  update(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.products.update(consumer, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('products:write')
  @ApiOperation({
    summary: 'Delete a product',
    description:
      'Deletes the product for good. To keep its record, set `active: false` ' +
      'with `PATCH` instead.',
  })
  @ApiOkResponse({ type: ProductDeletedEntity })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.products.remove(consumer, id);
  }
}
