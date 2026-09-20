import { createHash } from 'node:crypto';

const ITEM_REF_DOMAIN = 'cosmos-pay:private-rfq:v1:';
const MEMO_MAX = (1n << 64n) - 1n;

/** Deterministic item_ref clients must use when creating the Sub Rosa round. */
export function privateRfqItemRef(reference: string): Buffer {
  return createHash('sha256')
    .update(`${ITEM_REF_DOMAIN}${reference.trim()}`, 'utf8')
    .digest();
}

/** Stable MEMO_ID makes payment-intent handoff idempotent under concurrent calls. */
export function privateRfqMemo(id: string): string {
  const digest = createHash('sha256')
    .update(`cosmos-pay:private-rfq-payment:v1:${id}`, 'utf8')
    .digest();
  const value = digest.readBigUInt64BE(0) & MEMO_MAX;
  return (value === 0n ? 1n : value).toString();
}
