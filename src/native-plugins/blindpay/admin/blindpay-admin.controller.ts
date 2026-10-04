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
  UseInterceptors,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { AdminPrincipal } from '@/admin/admin-auth';
import { toNum } from '@/admin/admin-list';
import { AdminReadAuditInterceptor } from '@/admin/admin-read-audit.interceptor';
import { CurrentAdmin } from '@/common/decorators/current-admin.decorator';
import { AdminGuard } from '@/common/guards/admin.guard';
import { BlindpayAdminService } from '@/native-plugins/blindpay/admin/blindpay-admin.service';
import { ApproveReceiverDto } from '@/native-plugins/blindpay/kyc/receivers/dto/approve-receiver.dto';
import { EnableReceiverDto } from '@/native-plugins/blindpay/kyc/receivers/dto/enable-receiver.dto';
import { RequestTosDto } from '@/native-plugins/blindpay/kyc/receivers/dto/request-tos.dto';
import { SetAccessDto } from '@/native-plugins/blindpay/kyc/receivers/dto/set-access.dto';
import { resolveTosCooldownMs } from '@/native-plugins/blindpay/kyc/receivers/tos-cooldown-header';

/**
 * The BlindPay plugin's platform-admin routes, under the core's `/v1/admin`
 * prefix and behind the same console-only guard and read-audit interceptor as
 * the core admin controller, so an operator cannot tell which one serves a
 * route. Excluded from the OpenAPI contract, like the rest of `/v1/admin`.
 */
@ApiExcludeController()
@UseInterceptors(AdminReadAuditInterceptor)
@UseGuards(AdminGuard)
@Controller({ path: 'admin', version: '1' })
export class BlindpayAdminController {
  constructor(private readonly admin: BlindpayAdminService) {}

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

  @Patch('receivers/:id/access')
  setReceiverAccess(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: SetAccessDto,
  ) {
    return this.admin.setReceiverAccess(id, dto.disabled, actor);
  }

  @Post('receivers/:id/approve')
  approveReceiver(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: ApproveReceiverDto,
  ) {
    return this.admin.approveReceiver(
      id,
      dto.redirect_url,
      actor,
      dto.expected_version,
    );
  }

  @Post('receivers/:id/enable')
  enableReceiver(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: EnableReceiverDto,
  ) {
    return this.admin.enableReceiver(id, dto.tos_id, actor);
  }

  @Post('receivers/:id/tos')
  requestReceiverTos(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: RequestTosDto,
    @Headers('x-cosmos-internal') internal?: string,
    @Headers('x-cosmos-tos-cooldown-ms') cooldown?: string,
  ) {
    return this.admin.requestReceiverTos(
      id,
      dto,
      actor,
      resolveTosCooldownMs(internal, cooldown),
    );
  }
}
