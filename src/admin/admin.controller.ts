import {
  Controller,
  Get,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AdminAuditService } from '@/admin/admin-audit.service';
import { AdminReadAuditInterceptor } from '@/admin/admin-read-audit.interceptor';
import { AdminService } from '@/admin/admin.service';
import {
  AdminChainSwapsQueryDto,
  AdminConsumerListQueryDto,
  AdminCrossChainSwapsQueryDto,
  AdminPageQueryDto,
  AdminPaymentIntentsQueryDto,
  AdminSwapsQueryDto,
} from '@/admin/dto/admin-list.query.dto';
import { AdminGuard } from '@/common/guards/admin.guard';

/**
 * Platform-admin (owner) endpoints: a global, cross-consumer view of everything in the
 * service. Gated by {@link AdminGuard} — a call from the platform console, which has
 * already established that the signed-in account is an owner/admin. Every route here is
 * audited, reads included. Not part of the public API surface, so excluded from the
 * OpenAPI spec.
 *
 * Native plugins add their own routes under the same prefix, behind the same guard
 * and read-audit interceptor (BlindPay: `receivers`, `payins`, `payouts`).
 */
@ApiExcludeController()
@UseInterceptors(AdminReadAuditInterceptor)
@UseGuards(AdminGuard)
@Controller({ path: 'admin', version: '1' })
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get('summary')
  summary(@Query('network') network?: string) {
    return this.admin.summary(network);
  }

  @Get('consumers')
  consumers(@Query() q: AdminPageQueryDto) {
    return this.admin.consumers(q.take, q.skip);
  }

  @Get('payment-intents')
  paymentIntents(@Query() q: AdminPaymentIntentsQueryDto) {
    return this.admin.paymentIntents(q);
  }

  @Get('swaps')
  swaps(@Query() q: AdminSwapsQueryDto) {
    return this.admin.swaps(q);
  }

  @Get('chain-swaps')
  chainSwaps(@Query() q: AdminChainSwapsQueryDto) {
    return this.admin.chainSwaps(q);
  }

  @Get('cross-chain-swaps')
  crossChainSwaps(@Query() q: AdminCrossChainSwapsQueryDto) {
    return this.admin.crossChainSwaps(q);
  }

  @Get('customers')
  customers(@Query() q: AdminConsumerListQueryDto) {
    return this.admin.customers(q);
  }

  @Get('products')
  products(@Query() q: AdminConsumerListQueryDto) {
    return this.admin.products(q);
  }

  /**
   * Consultable, append-only admin audit trail. Intentionally read-only —
   * there is no DELETE/PATCH route for these rows (issue #34).
   */
  @Get('audit-logs')
  auditLogs(@Query() q: AdminPageQueryDto) {
    return this.audit.list(q);
  }
}
