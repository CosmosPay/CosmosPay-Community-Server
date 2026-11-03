import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ProtectedPaymentStatus } from '@generated/prisma/client';
import type { AdminPrincipal } from '@/admin/admin-auth';
import { AdminReadAuditInterceptor } from '@/admin/admin-read-audit.interceptor';
import { AdminConsumerListQueryDto } from '@/admin/dto/admin-list.query.dto';
import { CurrentAdmin } from '@/common/decorators/current-admin.decorator';
import { AdminGuard } from '@/common/guards/admin.guard';
import { ProtectedPaymentsAdminService } from '@/native-plugins/trustless-work/admin/protected-payments-admin.service';
import {
  ResolveProtectedPaymentDto,
  SubmitProtectedPaymentLinkDto,
} from '@/native-plugins/trustless-work/dto/protected-payment.dto';

export class AdminProtectedPaymentsQueryDto extends AdminConsumerListQueryDto {
  @IsOptional()
  @IsString()
  network?: string;

  @IsOptional()
  @IsEnum(ProtectedPaymentStatus)
  status?: ProtectedPaymentStatus;
}

/**
 * The `trustless-work` plugin's platform-admin routes, under the core's
 * `/v1/admin` prefix and behind the same console-only guard and read-audit
 * interceptor as the core admin controller. Excluded from the OpenAPI contract,
 * like the rest of `/v1/admin`.
 */
@ApiExcludeController()
@UseInterceptors(AdminReadAuditInterceptor)
@UseGuards(AdminGuard)
@Controller({ path: 'admin', version: '1' })
export class TrustlessWorkAdminController {
  constructor(private readonly admin: ProtectedPaymentsAdminService) {}

  @Get('protected-payments')
  list(@Query() q: AdminProtectedPaymentsQueryDto) {
    return this.admin.list(q);
  }

  @Post('protected-payments/:id/resolve')
  @HttpCode(HttpStatus.OK)
  resolve(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: ResolveProtectedPaymentDto,
  ) {
    return this.admin.resolve(id, dto, actor);
  }

  @Post('protected-payments/:id/submit')
  @HttpCode(HttpStatus.OK)
  submit(
    @CurrentAdmin() actor: AdminPrincipal,
    @Param('id') id: string,
    @Body() dto: SubmitProtectedPaymentLinkDto,
  ) {
    return this.admin.submit(id, dto.xdr, actor);
  }
}
