import type { StellarNetwork } from '@/config/configuration';

/**
 * Koywe, the provider behind payment requests paid by bank transfer: Cosmos
 * Pay is an organization with one merchant whose ARS virtual account (a CVU
 * and an alias) receives the payers' transfers; each deposit is converted to
 * the request's token (an ONRAMP quote and order) and delivered to the seller.
 * Read on 2026-11-12 from its docs (docs.koywe.com) and its OpenAPI 3.1 spec.
 *
 * The published contract never names it: errors and the spec say "bank
 * transfer", and `requestUpstreamJson` tells a client about
 * {@link BANK_TRANSFER_SERVICE}. Code, comments and logs keep the real name.
 */
export const KOYWE_PROVIDER = 'Koywe';

/** How a client is told about the provider (`src/common/provider-names.constants.ts`). */
export const BANK_TRANSFER_SERVICE = 'the bank transfer partner';

/**
 * Upstream budget for one provider call. Every call is a plain read or a
 * single write; a slower answer is better cut than left holding the payer's
 * page or a sweep cycle.
 */
export const KOYWE_TIMEOUT_MS = 10_000;

/**
 * How long a sign-in token is reused. The provider's JWT lives about an hour;
 * signing in again ten minutes early keeps a call from racing its expiry, and a
 * 401 anyway signs in once more before the call is given up.
 */
export const KOYWE_TOKEN_TTL_MS = 50 * 60 * 1000;

/**
 * How long the ARS virtual account's alias and CVU are reused: they change
 * only when an operator changes them, and every payer asking for instructions
 * would otherwise be a provider call.
 */
export const KOYWE_DEPOSIT_ACCOUNT_TTL_MS = 10 * 60 * 1000;

/**
 * How long a payer's deposit instructions stay valid (capped by the request's
 * own `expiresAt`): an hour to open the bank app and transfer, short enough
 * that a stale instruction does not wait days for a deposit.
 */
export const BANK_TRANSFER_LIFETIME_MS = 60 * 60 * 1000;

/**
 * How long after `expiresAt` an awaiting transfer still matches a deposit. A
 * bank transfer can land late (a weekend, a bank's own checks): money that
 * arrives must reach the seller, not get stuck in Cosmos Pay's account.
 */
export const BANK_TRANSFER_MATCH_GRACE_MS = 24 * 60 * 60 * 1000;

/** The most awaiting transfers one deposit is compared with (one document, one network). */
export const BANK_TRANSFER_MATCH_CANDIDATES = 50;

/**
 * Asking for deposit instructions stores a row and may call the provider, with
 * no API key in front of it: ten a minute per address, like starting a P2P
 * purchase from the same page.
 */
export const BANK_TRANSFER_RATE_LIMIT = {
  name: 'payment-links-fiat:transfer',
  limit: 10,
  windowMs: 60 * 1000,
};

/** The header a delivery's signature arrives in: lowercase hex HMAC-SHA256 of the raw body. */
export const KOYWE_SIGNATURE_HEADER = 'koywe-signature';

/** A hex SHA-256 digest. */
export const KOYWE_SIGNATURE_RE = /^[0-9a-f]{64}$/i;

/**
 * The networks whose webhook secret a delivery is checked against, in order:
 * the one that verifies decides which network's transfers it may touch.
 */
export const KOYWE_WEBHOOK_NETWORKS: readonly StellarNetwork[] = [
  'public',
  'testnet',
];

/** The longest envelope id kept (the provider's are `evt_` and a short id). */
export const KOYWE_EVENT_ID_MAX = 128;

/** The event a deposit to the virtual account fires. */
export const KOYWE_BANK_INCOME_EVENT = 'bank_income.received';

/** The prefix of every order lifecycle event. */
export const KOYWE_ORDER_EVENT_PREFIX = 'order.';

/** The order type a conversion of ARS to a token is. */
export const KOYWE_ONRAMP = 'ONRAMP';

/** The only currency bank transfers take. */
export const BANK_TRANSFER_CURRENCY = 'ARS';

/** The approval policy's answer that lets an operation run at once. */
export const KOYWE_POLICY_ALLOW = 'ALLOW';

/** The order status a policy hold leaves an order in. */
export const KOYWE_ORDER_ON_HOLD = 'ON_HOLD';

/**
 * What each terminal order status means for a transfer; any other status is
 * still on its way. `CANCELED` and `CANCELLED` both appear in the provider's
 * docs.
 */
export const KOYWE_ORDER_OUTCOMES: Readonly<
  Record<string, 'completed' | 'failed'>
> = {
  COMPLETED: 'completed',
  FAILED: 'failed',
  EXPIRED: 'failed',
  CANCELED: 'failed',
  CANCELLED: 'failed',
  REFUNDED: 'failed',
};

/** What each terminal order event means for a transfer; any other order event only updates its status. */
export const KOYWE_ORDER_EVENT_OUTCOMES: Readonly<
  Record<string, 'completed' | 'failed'>
> = {
  'order.completed': 'completed',
  'order.failed': 'failed',
  'order.expired': 'failed',
  'order.canceled': 'failed',
  'order.cancelled': 'failed',
  'order.refunded': 'failed',
};

/** The provider networks v1 converts on: the EVM ones. */
export type KoyweNetwork = 'ETHEREUM' | 'POLYGON' | 'BASE' | 'BSC';

/** The tokens it delivers there. */
export type KoyweToken = 'USDC' | 'USDT';

/** Which tokens the provider's ONRAMP delivers on each network v1 uses (its docs' table). */
export const KOYWE_NETWORK_TOKENS: Readonly<
  Record<KoyweNetwork, readonly KoyweToken[]>
> = {
  ETHEREUM: ['USDC', 'USDT'],
  POLYGON: ['USDC', 'USDT'],
  BASE: ['USDC', 'USDT'],
  BSC: ['USDT'],
};

/** One mainnet token the rail delivers: where the provider sends it, and how the request stores it. */
export interface KoyweRailToken {
  network: KoyweNetwork;
  token: KoyweToken;
  decimals: number;
}

/**
 * The mainnet pairs a `public` request can be paid by bank transfer in: EIP-155
 * chain id, then the token contract (lowercase), checked against each chain's
 * explorer. BSC's USDT has 18 decimals; every other one 6.
 */
export const KOYWE_PUBLIC_RAIL: Readonly<
  Record<number, Readonly<Record<string, KoyweRailToken>>>
> = {
  1: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
      network: 'ETHEREUM',
      token: 'USDC',
      decimals: 6,
    },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': {
      network: 'ETHEREUM',
      token: 'USDT',
      decimals: 6,
    },
  },
  137: {
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': {
      network: 'POLYGON',
      token: 'USDC',
      decimals: 6,
    },
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': {
      network: 'POLYGON',
      token: 'USDT',
      decimals: 6,
    },
  },
  8453: {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': {
      network: 'BASE',
      token: 'USDC',
      decimals: 6,
    },
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': {
      network: 'BASE',
      token: 'USDT',
      decimals: 6,
    },
  },
  56: {
    '0x55d398326f99059ff775485246999027b3197955': {
      network: 'BSC',
      token: 'USDT',
      decimals: 18,
    },
  },
};

/** How often the sweep looks for conversions to start again or orders to read back. */
export const BANK_TRANSFER_SWEEP_INTERVAL_MS = 60 * 1000;

/** Transfers of each kind (to convert, to read back) one cycle handles per network. */
export const BANK_TRANSFER_SWEEP_BATCH = 5;

/**
 * Provider calls one cycle may make, at most: a conversion is up to five
 * (an order read, an account search and create, a quote, an order), a read back
 * one. The cycle's lock is held for that many timeouts.
 */
export const BANK_TRANSFER_SWEEP_MAX_CALLS = 40;

/** An order not finished after this long is read back from the provider (the webhook may have been lost). */
export const BANK_TRANSFER_ORDER_RECHECK_MS = 10 * 60 * 1000;

/**
 * How long a conversion attempt holds a transfer: the webhook's attempt and
 * the sweep's never run at once, and a process that died mid-attempt gives
 * the transfer back after this.
 */
export const BANK_TRANSFER_CLAIM_MS = 5 * 60 * 1000;

/**
 * Retry pacing of a conversion that failed: a minute, doubling, at most an hour
 * (a policy hold waits for a person; an hour apart is often enough to notice it
 * was lifted without asking the provider every minute).
 */
export const BANK_TRANSFER_RETRY_BASE_MS = 60 * 1000;
export const BANK_TRANSFER_RETRY_MAX_MS = 60 * 60 * 1000;

/** The longest reason kept on a stuck transfer (one line). */
export const BANK_TRANSFER_REASON_MAX = 200;

/** What a seller's bank transfer account reads as. `none`: there is no row. */
export const TRANSFER_ACCOUNT_STATUSES = [
  'none',
  'pending',
  'in_review',
  'approved',
  'rejected',
] as const;
export type TransferAccountStatus = (typeof TRANSFER_ACCOUNT_STATUSES)[number];

/** The provider's KYB statuses, as an account reads them. An unknown one is `in_review`. */
export const KOYWE_KYB_STATUSES: Readonly<
  Record<string, Exclude<TransferAccountStatus, 'none'>>
> = {
  CREATED: 'pending',
  PENDING: 'pending',
  IN_PROGRESS: 'in_review',
  MANUAL_REVIEW: 'in_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  FAILED: 'rejected',
};

/** What each KYB webhook event means for an account; `merchant.created` and the rest change nothing. */
export const KOYWE_KYB_EVENTS: Readonly<
  Record<string, Exclude<TransferAccountStatus, 'none' | 'pending'>>
> = {
  'merchant.kyb.in_progress': 'in_review',
  'merchant.kyb.approved': 'approved',
  'merchant.kyb.rejected': 'rejected',
};

/** The kinds of account a seller opens. */
export const TRANSFER_ACCOUNT_TYPES = ['person', 'company'] as const;
export type TransferAccountType = (typeof TRANSFER_ACCOUNT_TYPES)[number];

/**
 * The CUIT/CUIL prefixes each account type may have: 20, 23, 24, 25, 26 and 27
 * are people (a CUIL, or a person's CUIT), 30, 33 and 34 companies.
 */
export const TAX_ID_PREFIXES: Readonly<
  Record<TransferAccountType, readonly string[]>
> = {
  person: ['20', '23', '24', '25', '26', '27'],
  company: ['30', '33', '34'],
};

/** The provider's tax id type each account type is opened with. */
export const KOYWE_TAX_ID_TYPES: Readonly<Record<TransferAccountType, string>> =
  {
    person: 'CUIL',
    company: 'CUIT',
  };

/** Every seller merchant is Argentine, paid in ARS. */
export const KOYWE_MERCHANT_COUNTRY = 'AR';

/** The language the provider's hosted KYB form opens in. */
export const KOYWE_KYB_LANGUAGE = 'es';

/** A seller merchant's slug: this prefix and the account's id (unique, and names nobody). */
export const KOYWE_MERCHANT_SLUG_PREFIX = 'cosmospay-';

/**
 * How often a pending or in-review account's KYB is read back by the sweep:
 * the webhook says it first, and a lost delivery is noticed within this.
 */
export const TRANSFER_ACCOUNT_KYB_RECHECK_MS = 10 * 60 * 1000;

/**
 * How often a read may ask the provider for a missing verification link: the
 * provider makes the link a moment after the KYB is triggered, and a page
 * polling the account must not turn into a client polling the provider.
 */
export const TRANSFER_ACCOUNT_LINK_REFRESH_MS = 30 * 1000;

/** Accounts the sweep reads back per network per cycle. */
export const TRANSFER_ACCOUNT_SWEEP_BATCH = 10;

/**
 * How long a request owner's account status is reused by the rail: a list of
 * a hundred requests asks once, and an approval shows up within seconds.
 */
export const TRANSFER_ACCOUNT_CACHE_TTL_MS = 5 * 1000;
export const TRANSFER_ACCOUNT_CACHE_MAX_ENTRIES = 1000;

/** The KYB status reason kept on a rejected account (one line). */
export const TRANSFER_ACCOUNT_REASON_MAX = 300;

/**
 * Opening an account creates a merchant at the provider and starts a KYB:
 * a person opens one, and five a minute is room to fix a typo, not to fill the
 * organization with merchants.
 */
export const TRANSFER_ACCOUNT_RATE_LIMIT = {
  name: 'onramp-transfer:account',
  limit: 5,
  windowMs: 60 * 1000,
};
