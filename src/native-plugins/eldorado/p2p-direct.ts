import { randomBytes } from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { isEmail } from 'class-validator';
import { cbuCheckDigitsValid } from '@/common/cbu';
import { cuitCheckDigitValid } from '@/common/cuit';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { UpstreamStatusError } from '@/common/upstream-http';
import {
  P2P_DIRECT_BANKS,
  P2P_DIRECT_CURRENCY,
  P2P_DIRECT_DEFAULT_LANGUAGE,
  P2P_DIRECT_LANGUAGES,
  P2P_DIRECT_PAYMENT_METHOD,
  P2P_DIRECT_PHONE_PREFIX,
  P2P_DIRECT_TRADING_LEVEL,
  P2P_DIRECT_USERNAME_PREFIX,
} from '@/native-plugins/eldorado/eldorado.constants';

/**
 * The direct flow's pure rules (a payment request paid from the payer's page
 * through the marketplace's API): what the marketplace's answers read as for
 * the page, what the page's input becomes for the marketplace, and which of
 * this service's errors a marketplace refusal is. No Nest container and no
 * I/O, so a spec calls them on plain objects.
 *
 * Every reader is defensive: it reads only the fields the page needs, each
 * checked for its shape, and never passes a marketplace value on unread.
 */

type Json = Record<string, unknown>;

function objectAt(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** A plain id or enum value (letters, digits, `_`, `-`, `.`, `:`), or null. */
function word(value: unknown, max = 128): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max && /^[A-Za-z0-9_.:-]+$/.test(text)
    ? text
    : null;
}

/** One line of text a person typed (a name), bounded, or null. */
function line(value: unknown, max = 140): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && text.length <= max ? text : null;
}

/** A non-negative decimal (string or number), or null. */
function decimal(value: unknown): string | null {
  const text =
    typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  return /^\d{1,30}(\.\d{1,36})?$/.test(text) ? text : null;
}

/** An ISO date the marketplace sent, normalised; null when it is not one. */
function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}

/** A value as a log may show it: an enum-like word, else a placeholder. Never free text. */
function tag(value: unknown): string {
  if (value === undefined || value === null) return 'none';
  return word(value, 32) ?? '(other)';
}

// --- availability -----------------------------------------------------------

/** What switches the direct flow on for a deployment. */
export interface DirectSettings {
  clientId: string;
  apiReferralId: string;
  directSessionSecret: string;
}

/** Whether this deployment can serve the direct flow at all: the client id, the API referral id and the session secret. */
export function directConfigured(settings: DirectSettings): boolean {
  return Boolean(
    settings.clientId && settings.apiReferralId && settings.directSessionSecret,
  );
}

/**
 * `p2pDirect` of a request: the deployment serves the flow, the request is in
 * ARS (the one currency whose bank transfers it takes), and the marketplace
 * rail can pay it now (`methods` holds `p2p`). `methods` keeps meaning what it
 * meant: the page picks the direct flow over the window with this flag.
 */
export function p2pDirectAvailable(
  configured: boolean,
  request: { currency: string; methods: readonly string[] },
): boolean {
  return (
    configured &&
    request.currency.toUpperCase() === P2P_DIRECT_CURRENCY &&
    request.methods.includes('p2p')
  );
}

// --- sign-in ----------------------------------------------------------------

export type DirectLanguage = (typeof P2P_DIRECT_LANGUAGES)[number];

/**
 * The language of the sign-in email, from the page's `Accept-Language`: the
 * first of `es`, `en`, `pt` it prefers (by `q`, then order), else Spanish.
 */
export function directLanguage(header: string | undefined): DirectLanguage {
  if (!header) return P2P_DIRECT_DEFAULT_LANGUAGE;
  const ranked = header
    .split(',')
    .slice(0, 20)
    .map((part, at) => {
      const [range, ...params] = part.trim().split(';');
      const q = params
        .map((p) => /^\s*q=([01](?:\.\d{0,3})?)\s*$/.exec(p))
        .find(Boolean);
      return {
        primary: range.trim().toLowerCase().split('-')[0],
        q: q ? Number(q[1]) : 1,
        at,
      };
    })
    .filter((entry) => entry.q > 0)
    .sort((a, b) => b.q - a.q || a.at - b.at);
  const found = ranked.find((entry) =>
    (P2P_DIRECT_LANGUAGES as readonly string[]).includes(entry.primary),
  );
  return (
    (found?.primary as DirectLanguage | undefined) ??
    P2P_DIRECT_DEFAULT_LANGUAGE
  );
}

/** What the sign-in start answers the page: the opaque challenge, and whether the email is new to the marketplace. */
export interface DirectLoginChallenge {
  challenge: string;
  newAccount: boolean;
}

/** The send-otp answer, or null when it carries no usable challenge. */
export function readLoginChallenge(raw: unknown): DirectLoginChallenge | null {
  const body = objectAt(raw);
  const challenge = body?.otpIdentifier;
  if (
    typeof challenge !== 'string' ||
    !challenge ||
    challenge.length > 512 ||
    !/^[\x21-\x7e]+$/.test(challenge)
  ) {
    return null;
  }
  return { challenge, newAccount: body?.action === 'REGISTER' };
}

/** An email the marketplace can send a code to (at most 254 characters). */
export function isEmailAddress(email: string): boolean {
  return typeof email === 'string' && email.length <= 254 && isEmail(email);
}

/** An emailed sign-in code as the marketplace takes it: 8 or more letters and digits. */
export function isLoginCode(code: string): boolean {
  return /^[A-Za-z0-9]{8,32}$/.test(code);
}

/** A texted phone code: 4 digits. */
export function isPhoneCode(code: string): boolean {
  return /^\d{4}$/.test(code);
}

/** The verify-otp answer's token and its expiry (ms), or null without a token. */
export function readLoginSession(
  raw: unknown,
): { token: string; expiresAt: number | null } | null {
  const body = objectAt(raw);
  const token = body?.token;
  if (typeof token !== 'string' || !token || token.length > 4096) return null;
  const expires = isoDate(body?.expiresAt);
  return { token, expiresAt: expires ? Date.parse(expires) : null };
}

/**
 * A username for a new marketplace account, when the marketplace demands one:
 * a prefix and random letters and digits (3 to 20 characters), nothing about
 * the payer.
 */
export function generatedUsername(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const random = [...randomBytes(10)]
    .map((byte) => alphabet[byte % alphabet.length])
    .join('');
  return `${P2P_DIRECT_USERNAME_PREFIX}${random}`;
}

// --- verification (KYC) -----------------------------------------------------

/** Where the payer stands: what the page asks next. */
export type DirectKycStep =
  'details' | 'phone' | 'document' | 'review' | 'rejected' | 'ready';

export const DIRECT_KYC_STEPS: readonly DirectKycStep[] = [
  'details',
  'phone',
  'document',
  'review',
  'rejected',
  'ready',
];

/** Why the details step must be filled again. */
export type DirectKycError = 'phone_taken' | 'phone_invalid';

export const DIRECT_KYC_ERRORS: readonly DirectKycError[] = [
  'phone_taken',
  'phone_invalid',
];

/** The marketplace's error on the next level, as the page reads it. */
const KYC_ERRORS: Readonly<Record<string, DirectKycError>> = {
  PHONE_NUMBER_EXIST: 'phone_taken',
  PHONE_NUMBER_INVALID: 'phone_invalid',
};

const KYC_STATUSES = [
  'started',
  'pending',
  'passed',
  'rejected',
  'needed',
] as const;
type KycStatus = (typeof KYC_STATUSES)[number];

/** What `GET .../direct/kyc` answers. */
export interface DirectKyc {
  step: DirectKycStep;
  documentUrl: string | null;
  error: DirectKycError | null;
  limitUsd: string | null;
}

/** A level `L0`..`L5` as its number, or null. */
function levelOf(value: unknown): number | null {
  const match = typeof value === 'string' ? /^L([0-5])$/.exec(value) : null;
  return match ? Number(match[1]) : null;
}

function statusOf(value: unknown): KycStatus | null {
  return (KYC_STATUSES as readonly unknown[]).includes(value)
    ? (value as KycStatus)
    : null;
}

/** An http(s) URL the page may open in a new tab, or null (never a `javascript:` one). */
function openableUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * The step `GET /kyc`'s `kyc` reads as, and `unmapped` (the combination, by
 * enum values only) when it is one the mapping did not expect, for the caller
 * to log. A level is what the payer reached; the next level's status says
 * where they are on the way to it:
 *
 *   - L2 or above and passed: `ready` (L2 is the level that trades);
 *   - L1, on the way to L2: `document` with the verification link, `review`
 *     while it is pending, `rejected` once it is;
 *   - L0, on the way to L1: `phone` once the details were sent (started or
 *     pending, no error), else `details` with the marketplace's error.
 *
 * An unexpected combination still answers the likeliest step (above L2 but not
 * passed: `review`, or `rejected`; an unreadable level: as L0).
 */
export function readKyc(raw: unknown): {
  kyc: Omit<DirectKyc, 'limitUsd'>;
  unmapped: string | null;
} {
  const k = objectAt(raw) ?? {};
  const level = levelOf(k.kycLevel);
  const status = statusOf(k.kycStatus);
  const nextLevel = levelOf(k.kycNextLevel);
  const nextStatus = statusOf(k.kycNextLevelStatus);
  const error =
    typeof k.kycNextLevelError === 'string'
      ? (KYC_ERRORS[k.kycNextLevelError] ?? null)
      : null;
  const action = objectAt(k.action);
  const url = action?.type === 'url' ? openableUrl(action.value) : null;
  const combination =
    `level=${tag(k.kycLevel)} status=${tag(k.kycStatus)} ` +
    `next=${tag(k.kycNextLevel)} nextStatus=${tag(k.kycNextLevelStatus)} ` +
    `error=${tag(k.kycNextLevelError)}`;
  const answer = (
    step: DirectKycStep,
    expected: boolean,
    extra: Partial<Omit<DirectKyc, 'step' | 'limitUsd'>> = {},
  ) => ({
    kyc: { step, documentUrl: null, error: null, ...extra },
    unmapped: expected ? null : combination,
  });

  if (level !== null && level >= P2P_DIRECT_TRADING_LEVEL) {
    if (status === 'passed') return answer('ready', true);
    return answer(status === 'rejected' ? 'rejected' : 'review', false);
  }

  if (level === 1) {
    const expected =
      status === 'passed' &&
      (nextLevel === null || nextLevel === P2P_DIRECT_TRADING_LEVEL) &&
      nextStatus !== 'passed';
    if (nextStatus === 'pending') return answer('review', expected);
    if (nextStatus === 'rejected') return answer('rejected', expected);
    if (nextStatus === 'passed') return answer('review', false);
    return answer('document', expected && url !== null, { documentUrl: url });
  }

  // L0 (or a level this mapping cannot read): on the way to L1.
  const expected = level === 0 && (nextLevel === null || nextLevel === 1);
  if (nextStatus === 'passed') return answer('review', false);
  if ((nextStatus === 'started' || nextStatus === 'pending') && !error) {
    return answer('phone', expected);
  }
  return answer('details', expected, { error });
}

/**
 * What is left of the payer's monthly allowance in USD (`month_allowance_usd`
 * minus `month_consumed_usd`, a consumption it does not report counting as
 * none), two decimals, never below zero; null without an allowance.
 */
export function remainingLimitUsd(raw: unknown): string | null {
  const allowance = objectAt(raw);
  const total = decimal(allowance?.month_allowance_usd);
  if (!total) return null;
  const consumed = decimal(allowance?.month_consumed_usd) ?? '0';
  const cents = (value: string) => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
  };
  const left = cents(total) - cents(consumed);
  const positive = left > 0n ? left : 0n;
  return `${positive / 100n}.${String(positive % 100n).padStart(2, '0')}`;
}

/**
 * A phone as the first verification level takes it, `+54` and the number, or
 * null when it is not an Argentine one. Spaces, dashes, dots and parentheses
 * are dropped; then `+54` or `54` followed by 10 or 11 digits (the mobile `9`
 * included or not), or the 10 digits of the area code and number (a leading
 * trunk `0` dropped), which get `+54` in front.
 */
export function normalizeArPhone(input: string): string | null {
  if (typeof input !== 'string' || input.length > 32) return null;
  const compact = input.replace(/[\s().-]/g, '');
  const digits = P2P_DIRECT_PHONE_PREFIX.slice(1);
  if (new RegExp(`^\\+${digits}\\d{10,11}$`).test(compact)) return compact;
  if (new RegExp(`^${digits}\\d{10,11}$`).test(compact)) return `+${compact}`;
  if (/^0\d{10}$/.test(compact)) {
    return `${P2P_DIRECT_PHONE_PREFIX}${compact.slice(1)}`;
  }
  if (/^\d{10}$/.test(compact)) return `${P2P_DIRECT_PHONE_PREFIX}${compact}`;
  return null;
}

// --- bank accounts ----------------------------------------------------------

export type DirectBank = (typeof P2P_DIRECT_BANKS)[number];

/** One of the payer's saved accounts, as the page lists it: never a full number. */
export interface DirectAccount {
  id: string;
  holder: string;
  bank: string | null;
  hint: string | null;
}

/** A CVU/CBU: 22 digits. */
const CBU_RE = /^\d{22}$/;
/** An alias as the marketplace takes it. */
const ALIAS_RE = /^[A-Za-z0-9.-]{6,20}$/;

/**
 * The payer's saved ARS accounts (`GET /payment-details`), as the page may
 * show them: the id to pay with, the holder, the bank, and a hint (the
 * alias of an alias account, else the CVU/CBU's last four digits). Only their
 * own accounts (`ownershipType` SELF, or none given): a transfer must come from
 * an account in the payer's own name. An entry missing its id or its holder is
 * left out.
 */
export function readDirectAccounts(raw: unknown): DirectAccount[] {
  if (!Array.isArray(raw)) return [];
  const accounts: DirectAccount[] = [];
  for (const entry of raw.slice(0, 100)) {
    const item = objectAt(entry);
    const id = word(item?.id);
    const details = objectAt(item?.details);
    if (!item || !id || !details) continue;
    if (
      item.paymentMethodId !== undefined &&
      item.paymentMethodId !== P2P_DIRECT_PAYMENT_METHOD
    ) {
      continue;
    }
    if (item.ownershipType !== undefined && item.ownershipType !== 'SELF') {
      continue;
    }
    const holder = line(details.fullName);
    if (!holder) continue;
    const cbu =
      typeof details['CVU/CBU'] === 'string' &&
      CBU_RE.test(details['CVU/CBU'].trim())
        ? details['CVU/CBU'].trim()
        : null;
    const alias =
      typeof details.alias === 'string' && ALIAS_RE.test(details.alias.trim())
        ? details.alias.trim()
        : null;
    accounts.push({
      id,
      holder,
      bank: word(details.bankId, 40),
      hint:
        details.type === 'alias' && alias ? alias : cbu ? cbu.slice(-4) : alias,
    });
  }
  return accounts;
}

/** A bank account the payer typed, once its fields passed the DTO. */
export interface DirectAccountInput {
  holder: string;
  cbu: string;
  documentType: 'CUIT' | 'CUIL';
  document: string;
  bank: DirectBank;
  accountType: 'savings' | 'checking';
}

/** Why a typed account was refused: the field's own code, `invalid_account` for the rest. */
export interface AccountRefusal {
  code:
    | ApiErrorCode.InvalidAccount
    | ApiErrorCode.InvalidCbu
    | ApiErrorCode.InvalidDocument
    | ApiErrorCode.InvalidBank;
  message: string;
}

/**
 * One line a person typed: letters (any script), spaces and the punctuation a
 * name or a city has. No digits, no control or bidirectional characters.
 */
export const PERSON_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .,'’-]*$/u;

/** Separators a person types inside a number: spaces, dashes and dots. */
const NUMBER_SEPARATORS_RE = /[\s.-]/g;

/**
 * The bank account the payer typed, as this service sends it, or why not:
 * the holder's name (3 to 140 characters, `invalid_account`), the CVU/CBU (22
 * digits whose two check digits verify, separators dropped: `invalid_cbu`),
 * the tax id and its type (a CUIT or CUIL whose check digit verifies:
 * `invalid_document`), the bank (`invalid_bank`) and the account type
 * (`invalid_account`). Checked here rather than in the DTO so each field
 * answers its own code.
 */
export function parseDirectAccount(
  raw: unknown,
): { account: DirectAccountInput } | { refusal: AccountRefusal } {
  const refuse = (code: AccountRefusal['code'], message: string) => ({
    refusal: { code, message },
  });
  const input = objectAt(raw);
  if (!input) {
    return refuse(ApiErrorCode.InvalidAccount, 'account must be an object');
  }
  const holder =
    typeof input.holder === 'string'
      ? input.holder.replace(/\s+/g, ' ').trim()
      : '';
  if (
    holder.length < 3 ||
    holder.length > 140 ||
    !PERSON_NAME_RE.test(holder)
  ) {
    return refuse(
      ApiErrorCode.InvalidAccount,
      "account.holder must be the account holder's name",
    );
  }
  const cbu =
    typeof input.cbu === 'string'
      ? input.cbu.replace(NUMBER_SEPARATORS_RE, '')
      : '';
  if (!cbuCheckDigitsValid(cbu)) {
    return refuse(
      ApiErrorCode.InvalidCbu,
      'account.cbu must be a CVU or CBU: 22 digits whose two check digits verify',
    );
  }
  const documentType = input.documentType;
  if (documentType !== 'CUIT' && documentType !== 'CUIL') {
    return refuse(
      ApiErrorCode.InvalidDocument,
      'account.documentType must be CUIT or CUIL',
    );
  }
  const document =
    typeof input.document === 'string'
      ? input.document.replace(NUMBER_SEPARATORS_RE, '')
      : '';
  if (!cuitCheckDigitValid(document)) {
    return refuse(
      ApiErrorCode.InvalidDocument,
      'account.document must be a CUIT or CUIL: 11 digits whose check digit verifies',
    );
  }
  const bank = input.bank;
  if (
    typeof bank !== 'string' ||
    !(P2P_DIRECT_BANKS as readonly string[]).includes(bank)
  ) {
    return refuse(
      ApiErrorCode.InvalidBank,
      'account.bank must be one of the listed banks',
    );
  }
  const accountType = input.accountType;
  if (accountType !== 'savings' && accountType !== 'checking') {
    return refuse(
      ApiErrorCode.InvalidAccount,
      'account.accountType must be savings or checking',
    );
  }
  return {
    account: {
      holder,
      cbu,
      documentType,
      document,
      bank: bank as DirectBank,
      accountType,
    },
  };
}

/** A saved account's id as the marketplace issues them. */
export function isAccountId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

/** A typed account as the marketplace's `bank_tx_ar` details (the CVU/CBU form). */
export function accountDetails(
  account: DirectAccountInput,
): Record<string, string> {
  return {
    type: 'CVU/CBU',
    fullName: account.holder,
    'CVU/CBU': account.cbu,
    typeOfDocument: account.documentType,
    documentNumber: account.document,
    bankId: account.bank,
    accountType: account.accountType,
  };
}

// --- orders -----------------------------------------------------------------

/** An order as the page reads it. */
export type DirectOrderStatus =
  'matching' | 'pay' | 'confirming' | 'completed' | 'cancelled' | 'disputed';

export const DIRECT_ORDER_STATUSES: readonly DirectOrderStatus[] = [
  'matching',
  'pay',
  'confirming',
  'completed',
  'cancelled',
  'disputed',
];

/**
 * The marketplace's buy order statuses, as the page reads them. `pay`: a
 * seller accepted and waits for the transfer until `dueDate`; `confirming`:
 * the payer said they paid (or the seller confirmed it) and the token is on
 * its way. WAITING_FOR_FUNDS is a sale's and never reaches a purchase.
 */
const ORDER_STATUSES: Readonly<Record<string, DirectOrderStatus>> = {
  REQUESTED: 'matching',
  ACCEPTED: 'pay',
  FIAT_PAID: 'confirming',
  FIAT_RECEIVED: 'confirming',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  DISPUTED: 'disputed',
};

/** The raw status a payer may mark paid, and those they may still cancel. */
export const ORDER_PAYABLE_STATUS = 'ACCEPTED';
export const ORDER_CANCELLABLE_STATUSES: readonly string[] = [
  'REQUESTED',
  'ACCEPTED',
];

/** Where to transfer: the accepting seller's account, never more than the page shows. */
export interface DirectPayTo {
  holder: string;
  cbu: string | null;
  alias: string | null;
  bank: string | null;
}

/** What the order routes answer. */
export interface DirectOrder {
  id: string;
  status: DirectOrderStatus;
  amount: string;
  currency: string;
  payTo: DirectPayTo | null;
  dueAt: string | null;
  createdAt: string;
}

/** An order as read: the page's view, plus what this service checks and records. */
export interface ReadDirectOrder {
  view: DirectOrder;
  /** The marketplace's own status (REQUESTED, ACCEPTED, ...). */
  rawStatus: string;
  /** `externalReferenceId`: the payment request it was opened for. */
  reference: string | null;
  /** The token the quote delivers, for the seller's session record. */
  amountOut: string | null;
  /** Set when the status is not one the mapping knows (read as `matching`). */
  unmapped: string | null;
}

/** The accepting seller's account, or null when it does not name one the payer can transfer to. */
function payToOf(fiat: Json | null): DirectPayTo | null {
  const payee = objectAt(fiat?.payeeDetails);
  const holder = line(payee?.fullName);
  const rawCbu =
    typeof payee?.['CVU/CBU'] === 'string' ? payee['CVU/CBU'].trim() : '';
  const rawAlias = typeof payee?.alias === 'string' ? payee.alias.trim() : '';
  const cbu = CBU_RE.test(rawCbu) ? rawCbu : null;
  const alias = ALIAS_RE.test(rawAlias) ? rawAlias : null;
  if (!holder || (!cbu && !alias)) return null;
  return { holder, cbu, alias, bank: word(payee?.bankId, 40) };
}

/**
 * An order (`{ order }` of `/orders/...`) as the page reads it, or null when
 * it carries no id or status. `amount` and `currency` are what the payer
 * transfers (the quote's `in`), `fallback` when the order does not say; the
 * seller's account and the deadline only while the payer has to pay
 * (`pay`) or waits for the seller to confirm (`confirming`).
 */
export function readDirectOrder(
  raw: unknown,
  fallback: { amount: string; currency: string },
): ReadDirectOrder | null {
  const order = objectAt(objectAt(raw)?.order) ?? objectAt(raw);
  const id = word(order?.apiOrderId) ?? word(order?.orderId);
  const rawStatus = word(order?.orderStatus, 64);
  if (!order || !id || !rawStatus) return null;
  const known = ORDER_STATUSES[rawStatus];
  const status = known ?? 'matching';
  const quote = objectAt(order.quote);
  const quoteIn = objectAt(quote?.in);
  const quoteOut = objectAt(quote?.out);
  const live = status === 'pay' || status === 'confirming';
  return {
    view: {
      id,
      status,
      amount: decimal(quoteIn?.amount) ?? fallback.amount,
      currency: word(quoteIn?.currency, 16)?.toUpperCase() ?? fallback.currency,
      payTo: live ? payToOf(objectAt(order.fiatDetails)) : null,
      dueAt: live ? isoDate(order.dueDate) : null,
      createdAt:
        isoDate(order.createdDate) ??
        isoDate(order.createdAt) ??
        new Date().toISOString(),
    },
    rawStatus,
    reference: word(order.externalReferenceId),
    amountOut: decimal(quoteOut?.amount),
    unmapped: known ? null : `status=${tag(rawStatus)}`,
  };
}

/** The quote's id when `/quote/buy` answered one this service can order with, else null. */
export function quoteIdOf(raw: unknown): string | null {
  const quote = objectAt(raw);
  if (quote?.readonly === true) return null;
  return word(quote?.quoteId);
}

// --- errors -----------------------------------------------------------------

/** The marketplace call a refusal answered. */
export type DirectStep =
  | 'login'
  | 'verify'
  | 'kyc'
  | 'kycDetails'
  | 'kycPhone'
  | 'accounts'
  | 'quote'
  | 'order'
  | 'orderRead'
  | 'paid'
  | 'cancel';

const UNAVAILABLE =
  'Paying through a verified seller is not available right now: retry shortly or pay with another method.';

export const directErrors = {
  sessionExpired: () =>
    ApiError.unauthorized(
      ApiErrorCode.SessionExpired,
      'The payer session expired: verify your email again.',
    ),
  unavailable: () =>
    ApiError.unavailable(ApiErrorCode.P2pUnavailable, UNAVAILABLE),
  invalidCode: () =>
    ApiError.badRequest(
      ApiErrorCode.InvalidCode,
      'The code is wrong or expired.',
    ),
  invalidPhone: () =>
    ApiError.badRequest(
      ApiErrorCode.InvalidPhone,
      'phone must be an Argentine number: 10 digits with the area code, optionally after +54.',
    ),
  rejected: () =>
    ApiError.badRequest(
      ApiErrorCode.Rejected,
      'The request was refused. Check the details and try again.',
    ),
  kycRequired: () =>
    ApiError.conflict(
      ApiErrorCode.KycRequired,
      'Verify your identity before paying.',
    ),
  tooManyOrders: () =>
    ApiError.conflict(
      ApiErrorCode.TooManyOrders,
      'You already have two payments in progress: finish or cancel one before starting another.',
    ),
  noSellers: () =>
    ApiError.unavailable(
      ApiErrorCode.NoSellers,
      'No verified seller can take this payment right now: retry shortly.',
    ),
  orderNotFound: () => ApiError.notFound('Order not found'),
  notPayable: (status: DirectOrderStatus) =>
    ApiError.conflict(
      ApiErrorCode.OrderNotPayable,
      `This order is ${status}: only an order waiting for your transfer can be marked paid.`,
    ),
  notCancellable: (status: DirectOrderStatus) =>
    ApiError.conflict(
      ApiErrorCode.OrderNotCancellable,
      `This order is ${status}: only an order you have not paid yet can be cancelled.`,
    ),
  tooManyAttempts: () =>
    new ApiError(
      HttpStatus.TOO_MANY_REQUESTS,
      ApiErrorCode.RateLimited,
      'Too many attempts: wait a few minutes and try again.',
    ),
};

/**
 * What each step makes of a refusal before the shared rules: a code or status
 * that means something specific there. Null passes it on to the shared rules.
 */
const STEP_REFUSALS: Readonly<
  Record<DirectStep, (failure: UpstreamStatusError) => ApiError | null>
> = {
  login: () => null,
  verify: (f) =>
    f.code === 'UNABLE_TO_SIGNUP'
      ? directErrors.rejected()
      : f.status === 400 || f.status === 403
        ? directErrors.invalidCode()
        : null,
  kyc: () => null,
  // PHONE_NUMBER_COUNTRY_NOT_SUPPORTED, or INVALID_PARAMETERS about the phone.
  kycDetails: (f) =>
    f.code?.startsWith('PHONE_NUMBER') ||
    (f.status === 400 && f.mentions('phone'))
      ? directErrors.invalidPhone()
      : null,
  kycPhone: (f) =>
    f.status === 400 || f.status === 403 ? directErrors.invalidCode() : null,
  accounts: () => null,
  // A quote the marketplace cannot make is no seller to take the payment.
  quote: (f) => (f.status === 401 ? null : directErrors.noSellers()),
  order: (f) => {
    if (f.status === 429 || f.code === 'TOO_MANY_ACTIVE_ORDERS') {
      return directErrors.tooManyOrders();
    }
    if (f.code === 'PROFILE_NOT_READY') return directErrors.kycRequired();
    if (
      f.status === 404 ||
      f.status === 410 ||
      f.status === 422 ||
      f.code === 'INVALID_QUOTE' ||
      f.code === 'QUOTE_NOT_FOUND' ||
      f.code === 'EXPIRED_QUOTE'
    ) {
      return directErrors.noSellers();
    }
    return null;
  },
  orderRead: (f) =>
    f.status === 404 || f.status === 400 ? directErrors.orderNotFound() : null,
  paid: (f) =>
    f.status === 404
      ? directErrors.orderNotFound()
      : f.status === 403
        ? ApiError.conflict(
            ApiErrorCode.OrderNotPayable,
            'This order is not waiting for your transfer: it cannot be marked paid.',
          )
        : null,
  cancel: (f) =>
    f.status === 404
      ? directErrors.orderNotFound()
      : f.status === 403
        ? ApiError.conflict(
            ApiErrorCode.OrderNotCancellable,
            'This order can no longer be cancelled.',
          )
        : null,
};

/** The steps that run without the payer's token: a 401 there is this deployment's ids being refused. */
const UNAUTHENTICATED_STEPS: readonly DirectStep[] = ['login', 'verify'];

/**
 * This service's error for a marketplace refusal at `step`: the step's own
 * reading first, then the shared rules. A 401 is the payer's session (their
 * token expired) except before there is one, where it is the deployment's ids
 * (`p2p_unavailable`, for the operator to look at); a 429 is too many
 * attempts; a 5xx is the marketplace being down; any other 4xx is a neutral
 * `rejected`. No message relays the marketplace's text or names it.
 */
export function directRefusal(
  step: DirectStep,
  failure: UpstreamStatusError,
): ApiError {
  const specific = STEP_REFUSALS[step](failure);
  if (specific) return specific;
  if (failure.status === 401 || failure.code === 'SESSION_EXPIRED') {
    return UNAUTHENTICATED_STEPS.includes(step)
      ? directErrors.unavailable()
      : directErrors.sessionExpired();
  }
  if (failure.status === 429) return directErrors.tooManyAttempts();
  if (failure.status >= 500) return directErrors.unavailable();
  return directErrors.rejected();
}
