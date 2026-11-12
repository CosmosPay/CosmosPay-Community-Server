import { cuitCheckDigitValid } from '@/native-plugins/koywe/bank-transfer-document';
import { shortReason } from '@/native-plugins/koywe/bank-transfer';
import {
  KOYWE_KYB_STATUSES,
  KOYWE_MERCHANT_SLUG_PREFIX,
  TAX_ID_PREFIXES,
  TRANSFER_ACCOUNT_REASON_MAX,
  type TransferAccountStatus,
  type TransferAccountType,
} from '@/native-plugins/koywe/koywe.constants';

/**
 * A seller's bank transfer account (their own provider merchant): the pure
 * rules over a row. Pure, so a spec calls them on plain objects.
 */

/** Separators a person types between digits. */
const SEPARATORS_RE = /[-.\s]/g;

/**
 * A CUIT/CUIL as typed, for an account of `type`: 11 digits (dashes, dots
 * and spaces allowed) whose check digit verifies and whose prefix that type
 * can have (a company's CUIT is 30, 33 or 34). Answers the digits to send to
 * the provider and the three kept as a hint, or null.
 */
export function parseTaxId(
  type: TransferAccountType,
  input: string,
): { digits: string; hint: string } | null {
  if (typeof input !== 'string') return null;
  const digits = input.replace(SEPARATORS_RE, '');
  if (!cuitCheckDigitValid(digits)) return null;
  if (!TAX_ID_PREFIXES[type].includes(digits.slice(0, 2))) return null;
  return { digits, hint: digits.slice(-3) };
}

/** What a KYB status reads as; one the provider adds later is still under review. */
export function accountStatusOf(
  kybStatus: string | null | undefined,
): Exclude<TransferAccountStatus, 'none'> {
  return KOYWE_KYB_STATUSES[(kybStatus ?? '').toUpperCase()] ?? 'in_review';
}

/** A seller's merchant slug: derived from the account id, so it names nobody. */
export function merchantSlug(accountId: string): string {
  return `${KOYWE_MERCHANT_SLUG_PREFIX}${accountId}`;
}

/** The provider's reason for a status, as kept: one line, bounded. */
export function accountReason(reason: string | null): string | null {
  return reason ? shortReason(reason, TRANSFER_ACCOUNT_REASON_MAX) : null;
}

/** An account row as the reads load it. */
export interface TransferAccountRow {
  id: string;
  type: string;
  name: string;
  status: string;
  reason: string | null;
  verificationUrl: string | null;
  providerMerchantId: string | null;
  alias: string | null;
  cvu: string | null;
  bank: string | null;
  updatedAt: Date;
}

/** The seller's view of their account. */
export interface TransferAccountView {
  status: TransferAccountStatus;
  type: TransferAccountType | null;
  name: string | null;
  verificationUrl: string | null;
  reason: string | null;
  alias: string | null;
  cvu: string | null;
  bank: string | null;
  updatedAt: string | null;
}

/** No account yet. */
export const NO_TRANSFER_ACCOUNT: TransferAccountView = {
  status: 'none',
  type: null,
  name: null,
  verificationUrl: null,
  reason: null,
  alias: null,
  cvu: null,
  bank: null,
  updatedAt: null,
};

const STORED_STATUSES: readonly string[] = [
  'pending',
  'in_review',
  'approved',
  'rejected',
];

/**
 * What a seller reads of their account, field by field: the verification link
 * only while it is still to be used, the reason only once rejected, the
 * deposit account only once approved. Never the merchant id or the tax id.
 */
export function toTransferAccount(
  row: TransferAccountRow | null,
): TransferAccountView {
  if (!row) return NO_TRANSFER_ACCOUNT;
  const status = (
    STORED_STATUSES.includes(row.status) ? row.status : 'in_review'
  ) as Exclude<TransferAccountStatus, 'none'>;
  const verifying = status === 'pending' || status === 'in_review';
  const approved = status === 'approved';
  return {
    status,
    type: row.type === 'company' ? 'company' : 'person',
    name: row.name,
    verificationUrl: verifying ? row.verificationUrl : null,
    reason: status === 'rejected' ? row.reason : null,
    alias: approved ? row.alias : null,
    cvu: approved ? row.cvu : null,
    bank: approved ? row.bank : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Whether payers can be sent to this account: approved, with its merchant and a CVU and alias to give them. */
export function accountReady(row: {
  status: string;
  providerMerchantId: string | null;
  alias: string | null;
  cvu: string | null;
}): boolean {
  return Boolean(
    row.status === 'approved' && row.providerMerchantId && row.alias && row.cvu,
  );
}
