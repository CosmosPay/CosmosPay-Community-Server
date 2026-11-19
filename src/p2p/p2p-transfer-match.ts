/**
 * How well an incoming bank transfer fits an order a merchant waits to be
 * paid on. Pure; `P2pTransferMatchesService` has already kept only the
 * merchant's live purchases and charges in the transfer's currency for its
 * exact amount, so every candidate scores 1 for the amount, plus 1 when the
 * sender's name matches the payer the order names and 1 when the document
 * does. A merchant's bot releases on its own judgement: a score is a hint,
 * never a release.
 */

export interface TransferFacts {
  payerName?: string;
  payerDocument?: string;
}

export interface OrderPayer {
  name: string;
  document: string;
}

/** Lowercase, no accents, words only. */
export function normalizeName(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Two names match when every word of the shorter one is in the other: banks
 * shorten and reorder names ("GOMEZ JUAN" for "Juan Gómez", "JUAN C GOMEZ").
 * One-letter words (initials) are ignored.
 */
export function namesMatch(a: string, b: string): boolean {
  const x = normalizeName(a).filter((w) => w.length > 1);
  const y = normalizeName(b).filter((w) => w.length > 1);
  if (x.length === 0 || y.length === 0) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.every((w) => long.includes(w));
}

/**
 * Two documents match when their digits are equal, or one is the other inside
 * an Argentine CUIT/CUIL (two digits, the DNI, a check digit), which is how a
 * bank and a person often give the same identity.
 */
export function documentsMatch(a: string, b: string): boolean {
  const x = a.replace(/\D/g, '');
  const y = b.replace(/\D/g, '');
  if (x.length < 6 || y.length < 6) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return long.length === 11 && long.slice(2, 10) === short.padStart(8, '0');
}

/** The score and what it matched on. */
export function scoreTransfer(
  facts: TransferFacts,
  payer: OrderPayer | null,
): { score: number; matchedOn: string[] } {
  const matchedOn = ['amount'];
  if (payer && facts.payerName && namesMatch(facts.payerName, payer.name)) {
    matchedOn.push('name');
  }
  if (
    payer &&
    facts.payerDocument &&
    documentsMatch(facts.payerDocument, payer.document)
  ) {
    matchedOn.push('document');
  }
  return { score: matchedOn.length, matchedOn };
}
