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
import { WalletsService } from '@/native-plugins/blindpay/kyc/wallets/wallets.service';
import { CreateWalletDto } from '@/native-plugins/blindpay/kyc/wallets/dto/create-wallet.dto';
import {
  WalletEntity,
  WalletListEntity,
  WalletDeletedEntity,
} from '@/native-plugins/blindpay/kyc/wallets/entities/wallet.entity';

// /v1/kyc/receivers/:receiverId/wallets
@ApiTags('kyc')
@Controller({ path: 'kyc/receivers/:receiverId/wallets', version: '1' })
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  @Get('sign-message')
  // The challenge is BlindPay's to issue.
  @ApiUpstream('BlindPay')
  @RequirePermissions('kyc:read')
  @ApiOperation({
    summary: 'Get the message to sign for the secure wallet flow',
    description:
      'Fetches from BlindPay the message the customer signs in their own wallet to prove an EOA wallet is theirs. ' +
      'Sign it, then register the wallet with `POST /v1/kyc/receivers/{receiverId}/wallets` and its `signature_tx_hash` instead of an `address`. ' +
      'Nothing is stored.',
  })
  signMessage(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
  ) {
    return this.wallets.signMessage(consumer, receiverId);
  }

  @Post()
  @ApiUpstream('BlindPay')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary: 'Register a blockchain wallet for a receiver',
    description:
      'Registers the wallet at BlindPay under the receiver and mirrors it locally. ' +
      'Send `address` (account abstraction or the non-secure flow), or the `signature_tx_hash` of the message from ' +
      '`GET /v1/kyc/receivers/{receiverId}/wallets/sign-message` (secure EOA flow). ' +
      "`network` is one of BlindPay's: Stellar, Solana, Tron, Ethereum, Base, Arbitrum, Polygon or one of their test networks. " +
      'A disabled receiver is refused with 403 `account_disabled`.',
  })
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
  @ApiOperation({
    summary: "List a receiver's wallets",
    description:
      'Reads the local mirror, newest first; BlindPay is not called. ' +
      'Paginated with `take` (default 100, max 100) and `skip`; answers `{ data, total, take, skip }`.',
  })
  @ApiOkResponse({ type: WalletListEntity })
  findAll(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
    @Query() query: WidePaginationQueryDto,
  ) {
    return this.wallets.findAll(consumer, receiverId, query);
  }

  @Delete(':id')
  @ApiUpstream('BlindPay')
  @RequirePermissions('kyc:write')
  @ApiOperation({
    summary: 'Delete a wallet',
    description:
      'Deletes the wallet at BlindPay, then its local row. ' +
      'A wallet id this receiver does not have answers `deleted: true` without calling BlindPay, so repeating a delete succeeds.',
  })
  @ApiOkResponse({ type: WalletDeletedEntity })
  remove(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('receiverId') receiverId: string,
    @Param('id') id: string,
  ) {
    return this.wallets.remove(consumer, receiverId, id);
  }
}
