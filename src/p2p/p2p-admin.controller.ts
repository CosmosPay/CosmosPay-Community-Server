import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { AdminPrincipal } from '@/admin/admin-auth';
import { AdminReadAuditInterceptor } from '@/admin/admin-read-audit.interceptor';
import { CurrentAdmin } from '@/common/decorators/current-admin.decorator';
import { AdminGuard } from '@/common/guards/admin.guard';
import {
  AdminP2pDisputesQueryDto,
  AdminP2pMerchantDto,
  AdminP2pResolutionDto,
} from '@/p2p/dto/p2p-admin.dto';
import { P2pAdminService } from '@/p2p/p2p-admin.service';

/**
 * The P2P market's platform-admin routes, under the core's `/v1/admin`
 * prefix, behind the console-only guard and the read-audit interceptor like
 * every other admin route, and excluded from the OpenAPI contract with them.
 * The arbiter's key never reaches this server: `resolution` builds the
 * transaction its wallet signs.
 */
@ApiExcludeController()
@UseInterceptors(AdminReadAuditInterceptor)
@UseGuards(AdminGuard)
@Controller({ path: 'admin/p2p', version: '1' })
export class P2pAdminController {
  constructor(private readonly admin: P2pAdminService) {}

  @Get('disputes')
  disputes(@Query() query: AdminP2pDisputesQueryDto) {
    return this.admin.disputes(query);
  }

  @Get('orders/:id')
  order(@Param('id') id: string) {
    return this.admin.order(id);
  }

  @Post('orders/:id/resolution')
  resolution(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: AdminP2pResolutionDto,
  ) {
    return this.admin.resolution(id, dto, actor);
  }

  @Patch('merchants/:accountId')
  merchant(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('accountId') accountId: string,
    @Body() dto: AdminP2pMerchantDto,
  ) {
    return this.admin.setMerchantStatus(accountId, dto.merchantStatus, actor);
  }
}
