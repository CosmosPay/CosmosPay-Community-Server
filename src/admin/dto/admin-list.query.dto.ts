import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import {
  CrossChainSwapStatus,
  PaymentIntentStatus,
  SwapStatus,
} from '@generated/prisma/client';
import {
  ADMIN_DEFAULT_PAGE_SIZE,
  ADMIN_MAX_PAGE_SIZE,
} from '@/admin/admin.constants';

/**
 * Query strings of the platform-admin list routes, core and plugin alike.
 *
 * These used to be bare `@Query('status') status?: string` parameters handed to
 * Prisma as `status as never`, so `?status=BANANA` reached the database as an
 * enum it does not have and came back as a 500; `take` was parsed with a bare
 * `Number()`. Each list now names the enum its own column holds, and a value
 * outside it — or a page size outside the range — is a 400 at the pipe.
 *
 * Excluded from the OpenAPI contract with the rest of `/v1/admin`.
 */

/**
 * `take`/`skip` for an admin list: the shape of the tenant lists'
 * `PaginationQueryDto`, with the admin default and ceiling it has always had.
 */
export class AdminPageQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ADMIN_MAX_PAGE_SIZE)
  take: number = ADMIN_DEFAULT_PAGE_SIZE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;
}

/** A list that can be narrowed to one owning consumer (its local id). */
export class AdminConsumerListQueryDto extends AdminPageQueryDto {
  @IsOptional()
  @IsString()
  consumer?: string;
}

export class AdminPaymentIntentsQueryDto extends AdminConsumerListQueryDto {
  @IsOptional()
  @IsString()
  network?: string;

  @IsOptional()
  @IsEnum(PaymentIntentStatus)
  status?: PaymentIntentStatus;
}

export class AdminSwapsQueryDto extends AdminConsumerListQueryDto {
  @IsOptional()
  @IsString()
  network?: string;

  @IsOptional()
  @IsEnum(SwapStatus)
  status?: SwapStatus;
}

/** Solana / Monad swaps share the Stellar swaps' status enum. */
export class AdminChainSwapsQueryDto extends AdminConsumerListQueryDto {
  @IsOptional()
  @IsString()
  chain?: string;

  @IsOptional()
  @IsEnum(SwapStatus)
  status?: SwapStatus;
}

export class AdminCrossChainSwapsQueryDto extends AdminConsumerListQueryDto {
  @IsOptional()
  @IsEnum(CrossChainSwapStatus)
  status?: CrossChainSwapStatus;
}
