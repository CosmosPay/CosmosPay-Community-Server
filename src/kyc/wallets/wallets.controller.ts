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
import { WalletsService } from './wallets.service';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { WalletEntity } from './entities/wallet.entity';

// /v1/kyc/receivers/:receiverId/wallets
@ApiTags('kyc')
@Controller({ path: 'kyc/receivers/:receiverId/wallets', version: '1' })
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Get('sign-message')
  @RequirePermissions('kyc:read')
  @ApiOperation({
    summary: 'Get the message to sign for the secure wallet flow',
  })
  signMessage(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
  ) {
    return this.wallets.signMessage(consumer, receiverId);
  }

  @Post()
  @RequirePermissions('kyc:write')
  @ApiOperation({ summary: 'Register a blockchain wallet for a receiver' })
  @ApiCreatedResponse({ type: WalletEntity })
  create(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
    @Body() dto: CreateWalletDto,
  ) {
    return this.wallets.create(consumer, receiverId, dto);
  }

  @Get()
  @RequirePermissions('kyc:read')
  @ApiOperation({ summary: "List a receiver's wallets" })
  @ApiOkResponse({ type: [WalletEntity] })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
  ) {
    return this.wallets.findAll(consumer, receiverId);
  }

  @Delete(':id')
  @RequirePermissions('kyc:write')
  @ApiOperation({ summary: 'Delete a wallet' })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
    @Param('id') id: string,
  ) {
    return this.wallets.remove(consumer, receiverId, id);
  }
}
