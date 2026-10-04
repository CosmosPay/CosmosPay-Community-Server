import { Injectable, PipeTransform } from '@nestjs/common';
import { type Chain, CHAINS, isChain } from '@/chains/chains.constants';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';

/**
 * An optional `?chain=` query parameter: absent stays absent (the handler's
 * default applies), anything that is not a chain is a 400 naming the ones
 * that are.
 */
@Injectable()
export class ParseOptionalChainPipe implements PipeTransform<
  unknown,
  Chain | undefined
> {
  transform(value: unknown): Chain | undefined {
    if (value === undefined || value === '') return undefined;
    if (!isChain(value)) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        `chain must be one of: ${CHAINS.join(', ')}`,
      );
    }
    return value;
  }
}
