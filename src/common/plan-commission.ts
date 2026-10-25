import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';

/**
 * The plan commission (bps) to charge this request.
 *
 * The rate is the organization's, not the caller's: APISIX injects it per
 * consumer as `planSwapFeeBps` and it is NEVER a request parameter, so a client
 * cannot undercut or waive its own commission.
 *
 * What this cannot enforce is integrity — a forged header is indistinguishable
 * from an injected one by the time it reaches us — so the rate is only
 * trustworthy while the gateway's `proxy-rewrite` strip list names that header
 * alongside `Authorization`/`apikey`. See the APISIX section of the README;
 * that strip list is a deployment prerequisite, not something code substitutes
 * for.
 *
 * What it *can* enforce is presence, and it fails closed in production to do
 * it. Quietly falling back to `STELLAR_SWAP_FEE_BPS` the moment the gateway
 * stops forwarding the header would reprice every organization at the platform
 * default with no alert — the same class of silent-money bug as charging a fee
 * with no wallet configured to receive it. Outside production the fallback
 * stands so the service still runs locally with no gateway in front of it.
 *
 * This lives here, as a free function over `ConfigService`, because swaps and
 * liquidity pools charge the *same* commission and had drifted into two private
 * copies: the swaps copy failed closed, the pools copy silently fell back to
 * the platform default in production. Two implementations of one pricing rule
 * is one too many — a rule about money must have a single place to be wrong.
 */
export function resolvePlanCommissionBps(
  config: ConfigService<AppConfig, true>,
  consumer: GatewayConsumer,
): number {
  if (consumer.planSwapFeeBps !== null) {
    return consumer.planSwapFeeBps;
  }
  if (config.get('nodeEnv', { infer: true }) === 'production') {
    const header = config.get('apisix', { infer: true }).swapFeeBpsHeader;
    throw ApiError.unavailable(
      ApiErrorCode.Misconfigured,
      `The gateway did not forward the plan swap fee header (${header}), so ` +
        'the organization commission rate is unknown. Refusing to price at ' +
        'the configured default. Fix the APISIX consumer plugin that ' +
        'injects it.',
    );
  }
  const swap = config.get('stellar', { infer: true }).swap;
  return swap.feeWallet ? swap.feeBps : 0;
}

/**
 * The commission to charge, once it is known where it goes. A commission with no recipient
 * configured (`variable` names the missing setting) is a misconfiguration, not a free swap:
 * `misconfigured` (503), so the operator notices. The one exception is
 * `SWAP_COMMISSION_DEV_WAIVER=true`, which the service refuses to boot with in production
 * (env.validation.ts): there the commission is waived and the waiver logged, so a local
 * service can price and build swaps on chains whose fee accounts only the operator holds.
 */
export function commissionWithRecipient(
  config: ConfigService<AppConfig, true>,
  feeBps: number,
  recipient: string,
  variable: string,
): number {
  if (feeBps === 0 || recipient) return feeBps;
  if (config.get('swapCommissionDevWaiver', { infer: true })) {
    Logger.warn(
      `${variable} is not set: the ${feeBps} bps commission is waived (SWAP_COMMISSION_DEV_WAIVER)`,
      'SwapCommission',
    );
    return 0;
  }
  throw ApiError.unavailable(
    ApiErrorCode.Misconfigured,
    `A swap commission applies to this plan but ${variable} is not set`,
  );
}
