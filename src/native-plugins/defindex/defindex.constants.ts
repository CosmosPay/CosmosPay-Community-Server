import type { RateLimitPolicy } from '@/common/decorators/rate-limit.decorator';

/**
 * The largest amount (or share count) a DeFindex build accepts, in the vault
 * asset's minor units.
 *
 * `@defindex/sdk` takes amounts as JavaScript numbers, so anything past
 * `Number.MAX_SAFE_INTEGER` would reach DeFindex rounded: a different amount
 * from the one the caller asked for. The request is refused with a 400 before
 * DeFindex is called. It used to be checked inside the provider call, so an
 * oversized amount came back as `502 provider_error`, blaming DeFindex for the
 * caller's input.
 */
export const DEFINDEX_MAX_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

/** `slippageBps` when the request names none: 1%, DeFindex's own default. */
export const DEFINDEX_DEFAULT_SLIPPAGE_BPS = 100;

/**
 * The longest a built DeFindex transaction stays submittable, from the build.
 *
 * The binding lapses at the envelope's own `maxTime` when that comes first, which
 * is what the network enforces anyway. This cap is for an envelope with no upper
 * time bound, or a far one: without it a transaction built once could be relayed
 * for as long as its sequence number stays unused. Fifteen minutes is the
 * validity window the wallet itself accepts for a DeFindex envelope (its
 * `MAX_VALIDITY_SECONDS`), long enough for a hardware wallet or a SEP-7
 * signature on a phone.
 */
export const DEFINDEX_BUILD_TTL_MS = 15 * 60 * 1000;

/**
 * How long a submit holds its claim on a built transaction beyond the DeFindex
 * timeout (`DEFINDEX_TIMEOUT_MS`) before another submit may take it over.
 *
 * The claim is what makes a concurrent second submit wait (`409
 * operation_in_flight`) instead of sending the same transaction again. A process
 * that dies between the claim and DeFindex's answer would otherwise leave the
 * transaction claimed forever, so a claim older than the provider timeout plus
 * this margin is treated as abandoned. Taking it over can only resend the same
 * transaction, which the network applies at most once (its sequence number).
 */
export const DEFINDEX_SUBMIT_LEASE_MARGIN_MS = 30 * 1000;

/**
 * Budget for building a DeFindex deposit or withdrawal, per consumer + client
 * address, shared by both routes.
 *
 * Each build spends a call on this deployment's DeFindex API key (a quota every
 * tenant shares: DeFindex simulates the transaction) and stores a row the
 * submit is checked against. Twenty a minute matches `DEFINDEX_SUBMIT_RATE_LIMIT`,
 * as swaps do: an honest wallet builds once per submission.
 */
export const DEFINDEX_BUILD_RATE_LIMIT: RateLimitPolicy = {
  name: 'defindex:build',
  limit: 20,
  windowMs: 60 * 1000,
};

/**
 * Budget for `POST /v1/defindex/submit`, per consumer + client address.
 *
 * Every accepted submit is a DeFindex call on the shared API key. A replay of a
 * transaction already answered is served from the table, but it still counts:
 * the budget is on the route, not on the provider call.
 */
export const DEFINDEX_SUBMIT_RATE_LIMIT: RateLimitPolicy = {
  name: 'defindex:submit',
  limit: 20,
  windowMs: 60 * 1000,
};
