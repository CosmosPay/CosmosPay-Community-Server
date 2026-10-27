import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { ZkPaymentStatus } from '@generated/prisma/client';
import { PaginationQueryDto } from '@/common/dto/pagination.query.dto';

export class QueryZkPaymentsDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: ZkPaymentStatus,
    description:
      'Only payments in this status, as it reads now: `EXPIRED` includes a ' +
      'PENDING payment past `expiresAt`, and `PENDING` excludes one.',
  })
  @IsOptional()
  @IsEnum(ZkPaymentStatus)
  status?: ZkPaymentStatus;
}
