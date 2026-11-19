import { ApiParam } from '@nestjs/swagger';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { API_ERROR_CASES } from '@/common/errors/api-error.responses';

/**
 * The OpenAPI pieces the P2P controllers share: the failures their services
 * throw (each with the message those services really send) and the id
 * parameters. Kept apart so a message changes in one place.
 */

export const P2P_NETWORK_UNSUPPORTED_EXAMPLE = {
  [ApiErrorCode.NetworkUnsupported]: {
    summary: 'The P2P market does not run there for this key',
    message:
      'The P2P market does not run on scroll on testnet. It runs on 2 networks there: base, monad.',
    path: '/v1/p2p/quotes',
  },
};

/** The examples the P2P services really send, for the codes they share. */
const P2P_EXAMPLES = {
  ...P2P_NETWORK_UNSUPPORTED_EXAMPLE,
  [ApiErrorCode.InvalidStateTransition]: {
    summary: 'The order is not where this action needs it',
    message: 'This order is completed: it cannot be cancelled now.',
    path: '/v1/p2p/orders/3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10/cancel',
  },
  [ApiErrorCode.AssetUnsupported]: {
    summary: 'The token is not traded on that network',
    message:
      'The P2P market does not trade DAI on base: it trades USDC, USDT there.',
    path: '/v1/p2p/quotes',
  },
  [ApiErrorCode.QuoteExpired]: {
    summary: 'The quote expired',
    message: 'This quote expired: quote again.',
    path: '/v1/p2p/orders',
  },
  [ApiErrorCode.IdempotencyConflict]: {
    summary: 'This quote already made an order with another wallet',
    message:
      'An order already exists for this quote with another wallet. Quote again for a new order.',
    path: '/v1/p2p/orders',
  },
  [ApiErrorCode.OperationInFlight]: {
    summary: 'Someone is paying this charge right now',
    message:
      'Someone is paying this charge right now: try again when their order ends.',
    path: '/v1/p2p-checkout/charges/9b7e2c41-3f5a-4d8e-a1b2-c3d4e5f60718/orders',
  },
  [ApiErrorCode.RequestClosed]: {
    summary: 'The charge can no longer be paid',
    message:
      'P2P charge 9b7e2c41-3f5a-4d8e-a1b2-c3d4e5f60718 is paid: it can no longer be paid',
    path: '/v1/p2p-checkout/charges/9b7e2c41-3f5a-4d8e-a1b2-c3d4e5f60718/orders',
  },
};

/** One sentence per extra code: the P2P example's summary, else the table's. */
function extraText(codes: readonly ApiErrorCode[]): string {
  const summaries = P2P_EXAMPLES as Partial<
    Record<ApiErrorCode, { summary: string }>
  >;
  return codes
    .map((code) => {
      const summary = summaries[code]?.summary ?? API_ERROR_CASES[code].summary;
      return ` \`${code}\`: ${summary.replace(/\.?$/, '.')}`;
    })
    .join('');
}

/**
 * `400 network_unsupported` (the tier has no deployment, or not on that
 * network), with the route's other 400s.
 */
export const P2pNetworkRefusal = (...extra: ApiErrorCode[]) =>
  ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.NetworkUnsupported, ...extra],
    description:
      '`network_unsupported`: the P2P market does not run on the key’s tier yet, or not on that network (the message lists the networks it runs on).' +
      extraText(extra),
    examples: P2P_EXAMPLES,
  });

/** `409 p2p_no_match`, with the route's other 409s. */
export const P2pNoMatchResponse = (...extra: ApiErrorCode[]) =>
  ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.P2pNoMatch, ...extra],
    description:
      '`p2p_no_match`: no merchant can take the trade right now (price, limits, liquidity, rail, or the market is paused for new orders), or the quote’s merchant no longer can. Quote again, or try another amount, rail or network.' +
      extraText(extra),
    examples: P2P_EXAMPLES,
  });

/**
 * `404 not_found` on a route with no id in its path: a body names one of the
 * caller's rows (an account, an order) and it is not the caller's on this tier.
 */
export const P2pBodyRowNotFound = (what: string, path: string) =>
  ApiErrorResponse({
    status: 404,
    codes: [ApiErrorCode.NotFound],
    description: `The ${what} the body names is not one of yours on the key’s tier. Another consumer’s, or another tier’s, is the same answer.`,
    examples: {
      [ApiErrorCode.NotFound]: {
        summary: `No such ${what} of yours`,
        message: 'P2P account cm3p2pacc0001l70g8v5q3z2w not found',
        path,
      },
    },
  });

export const P2pOrderIdParam = () =>
  ApiParam({
    name: 'id',
    description: 'The order id (a uuid).',
    example: '3f1c2b7e-8d4a-4c1e-9b2f-6a5d4c3b2a10',
  });

export const P2pChargeIdParam = () =>
  ApiParam({
    name: 'id',
    description: 'The charge id (a uuid), as in its payer page URL.',
    example: '9b7e2c41-3f5a-4d8e-a1b2-c3d4e5f60718',
  });

export const P2pRowIdParam = (what: string, example: string) =>
  ApiParam({ name: 'id', description: `The ${what} id.`, example });
