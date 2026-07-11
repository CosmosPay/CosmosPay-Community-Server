import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AdminGuard } from '../common/guards/admin.guard';
import { ApproveReceiverDto } from '../kyc/receivers/dto/approve-receiver.dto';
import { EnableReceiverDto } from '../kyc/receivers/dto/enable-receiver.dto';
import { RequestTosDto } from '../kyc/receivers/dto/request-tos.dto';
import { SetAccessDto } from '../kyc/receivers/dto/set-access.dto';
import { resolveTosCooldownMs } from '../kyc/receivers/receivers.service';
import { AdminService } from './admin.service';

/**
 * Platform-admin (owner) endpoints: a global, cross-consumer view of everything in the
 * service. Gated by {@link AdminGuard} (trusted X-Cosmos-Admin marker the dev platform
 * sets only for verified platform owners/admins) on top of the global ApisixGuard. Not
 * part of the public API surface, so excluded from the OpenAPI spec.
 */
@ApiExcludeController()
@UseGuards(AdminGuard)
@Controller({ path: 'admin', version: '1' })
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('summary')
  summary(@Query('network') network?: string) {
    return this.admin.summary(network);
  }

  @Get('consumers')
  consumers(@Query('take') take?: string, @Query('skip') skip?: string) {
    return this.admin.consumers(toNum(take), toNum(skip));
  }

  @Get('payment-intents')
  paymentIntents(
    @Query('consumer') consumer?: string,
    @Query('network') network?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.paymentIntents({
      consumer,
      network,
      status,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  @Get('swaps')
  swaps(
    @Query('consumer') consumer?: string,
    @Query('network') network?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.swaps({
      consumer,
      network,
      status,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  @Get('customers')
  customers(
    @Query('consumer') consumer?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.customers({
      consumer,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  @Get('products')
  products(
    @Query('consumer') consumer?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.products({
      consumer,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  @Get('receivers')
  receivers(
    @Query('consumer') consumer?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.receivers({
      consumer,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  @Get('payins')
  payins(
    @Query('consumer') consumer?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.payins({
      consumer,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  @Get('payouts')
  payouts(
    @Query('consumer') consumer?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.payouts({
      consumer,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  // Global fiat kill-switch: enable/disable any receiver across consumers (owner-only,
  // gated by AdminGuard + the dev platform's platform-admin proxy).
  @Patch('receivers/:id/access')
  setReceiverAccess(@Param('id') id: string, @Body() dto: SetAccessDto) {
    return this.admin.setReceiverAccess(id, dto.disabled);
  }

  // Global review gate: approve a pending_review receiver in ANY org so the dev platform
  // can send the BlindPay terms email. Owner-only (AdminGuard + platform-admin proxy).
  @Post('receivers/:id/approve')
  approveReceiver(@Param('id') id: string, @Body() dto: ApproveReceiverDto) {
    return this.admin.approveReceiver(id, dto.redirect_url);
  }

  // Global activation: submit the accepted tos_id to create any receiver at BlindPay.
  @Post('receivers/:id/enable')
  enableReceiver(@Param('id') id: string, @Body() dto: EnableReceiverDto) {
    return this.admin.enableReceiver(id, dto.tos_id);
  }

  // Global resend of the terms-of-service (verification) link for a pending_user receiver in
  // ANY org, so the dev platform can re-send the verification email. Returns url + email. The
  // resend cooldown follows the platform role (owner immediate, admin 1/min) via the trusted
  // headers; AdminGuard already proved this is a dev-platform call, never an external key.
  @Post('receivers/:id/tos')
  requestReceiverTos(
    @Param('id') id: string,
    @Body() dto: RequestTosDto,
    @Headers('x-cosmos-internal') internal?: string,
    @Headers('x-cosmos-tos-cooldown-ms') cooldown?: string,
  ) {
    return this.admin.requestReceiverTos(
      id,
      dto,
      resolveTosCooldownMs(internal, cooldown),
    );
  }
}

function toNum(v?: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
