import {
  Controller,
  Get,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { AdminAuditService } from '@/admin/admin-audit.service';
import { toNum } from '@/admin/admin-list';
import { AdminReadAuditInterceptor } from '@/admin/admin-read-audit.interceptor';
import { AdminService } from '@/admin/admin.service';
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

  @Get('chain-swaps')
  chainSwaps(
    @Query('consumer') consumer?: string,
    @Query('chain') chain?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.chainSwaps({
      consumer,
      chain,
      status,
      take: toNum(take),
      skip: toNum(skip),
    });
  }

  @Get('cross-chain-swaps')
  crossChainSwaps(
    @Query('consumer') consumer?: string,
    @Query('status') status?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.admin.crossChainSwaps({
      consumer,
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

  /**
   * Consultable, append-only admin audit trail. Intentionally read-only —
   * there is no DELETE/PATCH route for these rows (issue #34).
   */
  @Get('audit-logs')
  auditLogs(@Query('take') take?: string, @Query('skip') skip?: string) {
    return this.audit.list({ take: toNum(take), skip: toNum(skip) });
  }
}
