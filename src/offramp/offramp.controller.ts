import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
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
import { OfframpService } from '@/offramp/offramp.service';
import { CreatePayoutQuoteDto } from '@/offramp/dto/create-payout-quote.dto';
import { AuthorizePayoutDto } from '@/offramp/dto/authorize-payout.dto';
import { CreatePayoutDto } from '@/offramp/dto/create-payout.dto';
import { PayoutDocumentDto } from '@/offramp/dto/payout-document.dto';
import { PayoutQuoteEntity } from '@/offramp/entities/payout-quote.entity';
import {
  PayoutEntity,
  PayoutListEntity,
} from '@/offramp/entities/payout.entity';

// /v1/offramp — stablecoin -> fiat.
@ApiTags('offramp')
@Controller({ path: 'offramp', version: '1' })
export class OfframpController {
  constructor(private readonly offramp: OfframpService) {}

  @Post('quotes')
  @RequirePermissions('offramp:write')
  @ApiOperation({
    summary: 'Create a payout quote (EVM quote carries the approve contract)',
  })
  @ApiCreatedResponse({ type: PayoutQuoteEntity })
  createQuote(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreatePayoutQuoteDto,
  ) {
    return this.offramp.createQuote(consumer, dto);
  }

  @Post('payouts/authorize')
  @RequirePermissions('offramp:write')
  @ApiOperation({
    summary: 'Build the unsigned Stellar/Solana payout tx to sign',
  })
  authorize(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: AuthorizePayoutDto,
  ) {
    return this.offramp.authorize(consumer, dto);
  }

  @Post('payouts')
  @RequirePermissions('offramp:write')
  @ApiOperation({ summary: 'Create a payout from a quote' })
  @ApiCreatedResponse({ type: PayoutEntity })
  createPayout(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Body() dto: CreatePayoutDto,
  ) {
    return this.offramp.createPayout(consumer, dto);
  }

  @Get('payouts')
  @RequirePermissions('offramp:read')
  @ApiOperation({ summary: "List the consumer's payouts" })
  @ApiOkResponse({ type: PayoutListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.offramp.findAll(consumer, query);
  }

  @Get('payouts/:id')
  @RequirePermissions('offramp:read')
  @ApiOperation({
    summary:
      'Get a payout (serves the local mirror; refreshes from BlindPay when stale)',
  })
  @ApiOkResponse({ type: PayoutEntity })
  findOne(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
  ) {
    return this.offramp.findOne(consumer, id);
  }

  @Post('payouts/:id/documents')
  @RequirePermissions('offramp:write')
  @ApiOperation({ summary: 'Attach a compliance document to a payout' })
  addDocument(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('id') id: string,
    @Body() dto: PayoutDocumentDto,
  ) {
    return this.offramp.addDocument(consumer, id, dto);
  }
}
