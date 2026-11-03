/**
 * Sub Rosa: private requests for quotes (RFQs) on Cosmos Pay.
 *
 * Written by the Sub Rosa contributors
 * (github.com/karagozemin/cosmospay-sub-rosa-plugin, 0.1.0); reviewed and
 * hardened by Cosmos Pay support for 0.2.0.
 *
 * The flow: a merchant creates an RFQ here; its companion client hashes the
 * RFQ into `itemRef` and opens a Sub Rosa `ReceiptOnly` sealed-proposal round
 * on Stellar with it; providers submit sealed proposals to the contract; after
 * the reveal the companion verifies the round's receipt and the merchant
 * records the provider it chose; finally the merchant links the Cosmos Pay
 * payment intent that pays that provider. `ReceiptOnly` moves no assets: the
 * money moves only through the payment intent.
 *
 * What this plugin checks itself, since it holds no network access
 * (`egress: []`) and cannot read the ledger:
 *
 *   - `itemRef` IS the SHA-256 of this RFQ's canonical JSON, recomputed here,
 *     so the round on chain is bound to the title, description and deadlines
 *     stored here, not to whatever hash the caller sent;
 *   - the round is on the reviewed Sub Rosa deployment for its network and
 *     protocol (pinned below), with the sealed-proposal schema;
 *   - a result comes after the commit deadline, with the receipt version of
 *     the round's protocol and a different transaction for each step;
 *   - the payment intent is this tenant's, on Stellar, on the round's network,
 *     still payable or paid, and pays the selected provider;
 *   - every write is a compare-and-set: two concurrent calls cannot both
 *     record a result, or both create the same RFQ.
 *
 * What it takes on trust: that the companion verified the receipt
 * (`clientVerified`), and that the transaction hashes are the round's. Both
 * are public evidence anyone can check against the ledger and the receipt.
 */
import {
  defineHandlers,
  optionalString,
  PluginError,
  requireString,
  type PluginContext,
  type PluginJson,
  type PluginJsonObject,
} from '@/plugins/sdk';

const COLLECTION = 'rfqs';
const SCHEMA_VERSION = 1;

/** The `schema` field of the canonical RFQ JSON `itemRef` is the hash of. */
const ITEM_REF_SCHEMA = 'cosmos-pay:sub-rosa-rfq:v1';

/** Sub Rosa's sealed-proposal v1 schema (`SEALED_PROPOSAL_SCHEMA_REF`). */
const SEALED_PROPOSAL_SCHEMA_REF =
  'b84a413c18205d4e45e80eff8ef29d322fbac1fd2f634b3fca9d9740c6176f6a';

const NETWORKS = ['testnet', 'mainnet'] as const;
const PROTOCOL_VERSIONS = ['core-v2', 'reveal-policy-v3'] as const;

type Network = (typeof NETWORKS)[number];
type ProtocolVersion = (typeof PROTOCOL_VERSIONS)[number];

/**
 * The reviewed Sub Rosa contracts, as `@sub-rosa/sdk` 0.3.2 publishes them
 * (`SUB_ROSA_DEPLOYMENTS`, `SUB_ROSA_REVEAL_POLICY_V3_DEPLOYMENTS`). A round on
 * any other contract is refused: a look-alike contract can emit a receipt of
 * its own making. `null`: none is published yet — reveal-policy v3 on mainnet
 * waits for its funds-handling review. A redeployment is a new plugin version.
 */
const DEPLOYMENTS: Readonly<
  Record<Network, Readonly<Record<ProtocolVersion, string | null>>>
> = {
  testnet: {
    'core-v2': 'CCOVGOQQZJKZ2R55GRWBLTJTGBAMSHXZVN3ICPG3WRVMLMM6RHISC5OV',
    'reveal-policy-v3':
      'CB7VIYY4RQLZG2Y6HLDWB3UKSVOAIDYFZ5TGW5AUBCIPJHTCZV4ZWQFF',
  },
  mainnet: {
    'core-v2': 'CDQOFNCJE5Z4ZZL76DU5652FOUKJVEIZWHFGCZVWH63UYBGPSZIPC325',
    'reveal-policy-v3': null,
  },
};

/** The receipt each protocol exports: Sub Rosa requires version = protocol. */
const RECEIPT_VERSION: Readonly<Record<ProtocolVersion, 2 | 3>> = {
  'core-v2': 2,
  'reveal-policy-v3': 3,
};

/** Cosmos Pay's name for each Sub Rosa network. */
const INTENT_NETWORK: Readonly<Record<Network, string>> = {
  testnet: 'testnet',
  mainnet: 'public',
};

/** Payment intent states that still pay the provider, or did. */
const LINKABLE_STATUSES: readonly string[] = [
  'PENDING',
  'SUBMITTED',
  'SUCCEEDED',
];

/** 9999-12-31T23:59:59Z: a deadline past it was sent in milliseconds. */
const MAX_UNIX_SECONDS = 253_402_300_799;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_32_RE = /^[0-9a-f]{64}$/i;
const ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
const CONTRACT_RE = /^C[A-Z2-7]{55}$/;
const ROUND_ID_RE = /^(0|[1-9][0-9]{0,38})$/;
const CORE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * An absolute `https:` URL of printable ASCII, with a host and no userinfo:
 * a locator a person may click, so nothing that renders differently from
 * what it is (no `user@`, no spaces, no Unicode look-alikes).
 */
const HTTPS_URL_RE =
  /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?(?:[/?#][\x21-\x7e]*)?$/i;

/**
 * Text a person reads later, in a dashboard or an audit: no control
 * characters, no bidirectional overrides, no invisible (default-ignorable)
 * characters, so what is shown is what was stored, and no unpaired surrogate,
 * which the database cannot store. A line break or a tab is allowed in the
 * multi-line fields.
 */
const SINGLE_LINE_FORBIDDEN_RE =
  /[\p{Cc}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\u2028\u2029]/u;
const MULTI_LINE_FORBIDDEN_RE =
  // eslint-disable-next-line no-control-regex -- the same, minus line breaks and tabs
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cs}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\u2028\u2029]/u;

interface SubRosaMapping {
  network: Network;
  contractId: string;
  roundId: string;
  protocolVersion: ProtocolVersion;
  mode: 'ReceiptOnly';
  schemaRef: string;
  itemRef: string;
  revealRound: number;
  creatorAddress: string | null;
  createTxHash: string | null;
  attachedAt: string;
}

interface SelectionEvidence {
  selectedProviderAddress: string;
  receiptHash: string;
  receiptUri: string | null;
  receiptVersion: 2 | 3;
  clientVerified: true;
  openRevealTxHash: string;
  revealTxHash: string;
  clearTxHash: string;
  notes: string | null;
  recordedAt: string;
}

interface RfqRecord {
  schemaVersion: 1;
  id: string;
  title: string;
  description: string | null;
  itemRef: string;
  commitDeadline: number;
  revealDeadline: number;
  status: 'draft' | 'round-attached' | 'provider-selected';
  createdAt: string;
  updatedAt: string;
  subRosa: SubRosaMapping | null;
  selection: SelectionEvidence | null;
  paymentIntentId: string | null;
}

// ── SHA-256 ───────────────────────────────────────────────────────────────────
// The isolate has no WebCrypto and no Node, so the hash `itemRef` is checked
// against is computed here, over the UTF-8 bytes of the text (FIPS 180-4).

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** UTF-8, a lone surrogate as U+FFFD (what Node's `Buffer` and TextEncoder do). */
function utf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
        i += 1;
      }
    }
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(
        0xe0 | (cp >> 12),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function sha256Hex(text: string): string {
  const message = utf8(text);
  const blocks = Math.ceil((message.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = message.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);

  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Array<number>(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let k = h[7];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (k + s1 + choice + SHA256_K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + k) >>> 0;
  }
  return h.map((word) => word.toString(16).padStart(8, '0')).join('');
}

/**
 * `itemRef`: SHA-256 of the RFQ's canonical JSON — keys sorted, no whitespace,
 * `description` null when absent. The companion's `canonicalRfqItemRef` builds
 * the same bytes; the key order below IS the sorted order.
 */
function canonicalItemRef(rfq: {
  rfqId: string;
  title: string;
  description: string | null;
  commitDeadline: number;
  revealDeadline: number;
}): string {
  return sha256Hex(
    JSON.stringify({
      commitDeadline: rfq.commitDeadline,
      description: rfq.description,
      revealDeadline: rfq.revealDeadline,
      rfqId: rfq.rfqId,
      schema: ITEM_REF_SCHEMA,
      title: rfq.title,
    }),
  );
}

// ── Input readers ─────────────────────────────────────────────────────────────

function assertOnly(input: PluginJsonObject, allowed: readonly string[]): void {
  for (const field of Object.keys(input)) {
    if (!allowed.includes(field)) {
      throw new PluginError(`Unexpected field: ${field.slice(0, 64)}`);
    }
  }
}

function checked(
  value: string,
  field: string,
  pattern: RegExp,
  description: string,
): string {
  if (!pattern.test(value)) {
    throw new PluginError(`${field} must be ${description}`);
  }
  return value;
}

function uuid(input: PluginJsonObject): string {
  return checked(
    requireString(input, 'rfqId', { max: 36 }),
    'rfqId',
    UUID_RE,
    'an RFC 4122 UUID',
  ).toLowerCase();
}

function hex32(input: PluginJsonObject, field: string): string {
  return checked(
    requireString(input, field, { max: 64 }),
    field,
    HEX_32_RE,
    'a 32-byte hexadecimal value',
  ).toLowerCase();
}

function account(input: PluginJsonObject, field: string): string {
  return checked(
    requireString(input, field, { max: 56 }),
    field,
    ACCOUNT_RE,
    'a structurally valid Stellar G... address',
  );
}

function optionalAccount(
  input: PluginJsonObject,
  field: string,
): string | null {
  const value = optionalString(input, field, { max: 56 });
  return value === undefined
    ? null
    : checked(
        value,
        field,
        ACCOUNT_RE,
        'a structurally valid Stellar G... address',
      );
}

function optionalTxHash(input: PluginJsonObject, field: string): string | null {
  const value = optionalString(input, field, { max: 64 });
  return value === undefined
    ? null
    : checked(
        value,
        field,
        HEX_32_RE,
        'a 32-byte transaction hash',
      ).toLowerCase();
}

function integer(
  input: PluginJsonObject,
  field: string,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const value = input[field];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new PluginError(`${field} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function unixSeconds(input: PluginJsonObject, field: string): number {
  const value = input[field];
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_UNIX_SECONDS
  ) {
    throw new PluginError(`${field} must be a Unix time in seconds`);
  }
  return value;
}

function enumValue<T extends string>(
  input: PluginJsonObject,
  field: string,
  values: readonly T[],
): T {
  const value = requireString(input, field, { max: 40 });
  if (!(values as readonly string[]).includes(value)) {
    throw new PluginError(`${field} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

function text(
  input: PluginJsonObject,
  field: string,
  max: number,
  forbidden: RegExp,
): string {
  return refuseHidden(field, requireString(input, field, { max }), forbidden);
}

function optionalText(
  input: PluginJsonObject,
  field: string,
  max: number,
  forbidden: RegExp,
): string | null {
  const value = optionalString(input, field, { max });
  return value === undefined ? null : refuseHidden(field, value, forbidden);
}

function refuseHidden(field: string, value: string, forbidden: RegExp): string {
  if (forbidden.test(value)) {
    throw new PluginError(
      `${field} contains a control, bidirectional or invisible character`,
    );
  }
  return value;
}

function optionalHttpsUri(input: PluginJsonObject): string | null {
  const value = optionalString(input, 'receiptUri', { max: 500 });
  if (value === undefined) return null;
  if (!HTTPS_URL_RE.test(value)) {
    throw new PluginError(
      'receiptUri must be an absolute https URL of printable ASCII, with no user@ part',
    );
  }
  return value;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ── Records ───────────────────────────────────────────────────────────────────

function asRecord(value: PluginJson | null): RfqRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const candidate = value as unknown as RfqRecord;
  return candidate.schemaVersion === SCHEMA_VERSION ? candidate : null;
}

function toJson(record: RfqRecord): PluginJson {
  return record as unknown as PluginJson;
}

async function requireRfq(
  ctx: PluginContext,
  rfqId: string,
): Promise<RfqRecord> {
  const record = asRecord(await ctx.storage.get(COLLECTION, rfqId));
  if (!record) throw new PluginError(`RFQ ${rfqId} not found`);
  return record;
}

/**
 * Writes `next` only if the record is still `current`, the value this call
 * read. A concurrent call that changed it first wins, and this one is refused
 * instead of silently overwriting it.
 */
async function commit(
  ctx: PluginContext,
  current: RfqRecord,
  next: RfqRecord,
): Promise<PluginJson> {
  const written = await ctx.storage.compareAndSet(
    COLLECTION,
    next.id,
    toJson(current),
    toJson(next),
  );
  if (!written) {
    throw new PluginError(
      `RFQ ${next.id} changed while this request ran; read it again and retry`,
    );
  }
  return toJson(next);
}

function updated(record: RfqRecord): RfqRecord {
  return { ...record, updatedAt: new Date().toISOString() };
}

// ── Handlers ──────────────────────────────────────────────────────────────────

export default defineHandlers({
  commands: {
    'create-rfq': async (ctx, input) => {
      assertOnly(input, [
        'rfqId',
        'title',
        'description',
        'itemRef',
        'commitDeadline',
        'revealDeadline',
      ]);
      const id = uuid(input);
      const title = text(input, 'title', 160, SINGLE_LINE_FORBIDDEN_RE);
      const description = optionalText(
        input,
        'description',
        1000,
        MULTI_LINE_FORBIDDEN_RE,
      );
      const commitDeadline = unixSeconds(input, 'commitDeadline');
      const revealDeadline = unixSeconds(input, 'revealDeadline');
      if (commitDeadline >= revealDeadline) {
        throw new PluginError('commitDeadline must be before revealDeadline');
      }
      if (commitDeadline <= nowSeconds()) {
        throw new PluginError('commitDeadline must be in the future');
      }
      const itemRef = hex32(input, 'itemRef');
      const expected = canonicalItemRef({
        rfqId: id,
        title,
        description,
        commitDeadline,
        revealDeadline,
      });
      if (itemRef !== expected) {
        throw new PluginError(
          `itemRef must be the SHA-256 of this RFQ's canonical JSON (${ITEM_REF_SCHEMA}, ` +
            `lowercase rfqId, trimmed title and description), which is ${expected}`,
        );
      }

      const now = new Date().toISOString();
      const record: RfqRecord = {
        schemaVersion: SCHEMA_VERSION,
        id,
        title,
        description,
        itemRef,
        commitDeadline,
        revealDeadline,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        subRosa: null,
        selection: null,
        paymentIntentId: null,
      };
      const created = await ctx.storage.compareAndSet(
        COLLECTION,
        id,
        null,
        toJson(record),
      );
      if (!created) throw new PluginError(`RFQ ${id} already exists`);
      return toJson(record);
    },

    'attach-sub-rosa-round': async (ctx, input) => {
      assertOnly(input, [
        'rfqId',
        'network',
        'contractId',
        'roundId',
        'protocolVersion',
        'mode',
        'schemaRef',
        'itemRef',
        'revealRound',
        'creatorAddress',
        'createTxHash',
      ]);
      const id = uuid(input);
      const current = await requireRfq(ctx, id);
      if (current.subRosa) {
        throw new PluginError(`RFQ ${id} already has a Sub Rosa round`);
      }
      const itemRef = hex32(input, 'itemRef');
      if (itemRef !== current.itemRef) {
        throw new PluginError('itemRef must match the RFQ canonical hash');
      }
      const schemaRef = hex32(input, 'schemaRef');
      if (schemaRef !== SEALED_PROPOSAL_SCHEMA_REF) {
        throw new PluginError(
          'schemaRef must be the Sub Rosa sealed-proposal v1 schema',
        );
      }
      const network = enumValue(input, 'network', NETWORKS);
      const protocolVersion = enumValue(
        input,
        'protocolVersion',
        PROTOCOL_VERSIONS,
      );
      const contractId = checked(
        requireString(input, 'contractId', { max: 56 }),
        'contractId',
        CONTRACT_RE,
        'a structurally valid Soroban C... contract id',
      );
      const reviewed = DEPLOYMENTS[network][protocolVersion];
      if (reviewed === null) {
        throw new PluginError(
          `Sub Rosa ${protocolVersion} has no reviewed deployment on ${network} yet`,
        );
      }
      if (contractId !== reviewed) {
        throw new PluginError(
          `contractId must be the reviewed Sub Rosa ${protocolVersion} deployment on ${network}, ${reviewed}`,
        );
      }
      const mapping: SubRosaMapping = {
        network,
        contractId,
        roundId: checked(
          requireString(input, 'roundId', { max: 39 }),
          'roundId',
          ROUND_ID_RE,
          'a non-negative decimal round id',
        ),
        protocolVersion,
        mode: enumValue(input, 'mode', ['ReceiptOnly'] as const),
        schemaRef,
        itemRef,
        revealRound: integer(input, 'revealRound', 1),
        creatorAddress: optionalAccount(input, 'creatorAddress'),
        createTxHash: optionalTxHash(input, 'createTxHash'),
        attachedAt: new Date().toISOString(),
      };
      return commit(
        ctx,
        current,
        updated({ ...current, status: 'round-attached', subRosa: mapping }),
      );
    },

    'record-result': async (ctx, input) => {
      assertOnly(input, [
        'rfqId',
        'selectedProviderAddress',
        'receiptHash',
        'receiptUri',
        'receiptVersion',
        'clientVerified',
        'openRevealTxHash',
        'revealTxHash',
        'clearTxHash',
        'notes',
      ]);
      const id = uuid(input);
      const current = await requireRfq(ctx, id);
      const round = current.subRosa;
      if (!round) {
        throw new PluginError(
          'Attach a Sub Rosa round before recording a result',
        );
      }
      if (current.selection) {
        throw new PluginError(`RFQ ${id} already has a recorded selection`);
      }
      if (input.clientVerified !== true) {
        throw new PluginError(
          'clientVerified must be true after companion-client receipt verification',
        );
      }
      // Proposals are sealed until the commit phase closes: a result before
      // then cannot come from the round.
      if (nowSeconds() < current.commitDeadline) {
        throw new PluginError(
          'A result can be recorded only after the commit deadline',
        );
      }
      const receiptVersion = integer(input, 'receiptVersion', 2, 3);
      const expectedVersion = RECEIPT_VERSION[round.protocolVersion];
      if (receiptVersion !== expectedVersion) {
        throw new PluginError(
          `receiptVersion must be ${expectedVersion} for a ${round.protocolVersion} round`,
        );
      }
      const openRevealTxHash = hex32(input, 'openRevealTxHash');
      const revealTxHash = hex32(input, 'revealTxHash');
      const clearTxHash = hex32(input, 'clearTxHash');
      const hashes = [
        round.createTxHash,
        openRevealTxHash,
        revealTxHash,
        clearTxHash,
      ].filter((hash): hash is string => hash !== null);
      if (new Set(hashes).size !== hashes.length) {
        throw new PluginError(
          'createTxHash, openRevealTxHash, revealTxHash and clearTxHash must be different transactions',
        );
      }
      const selection: SelectionEvidence = {
        selectedProviderAddress: account(input, 'selectedProviderAddress'),
        receiptHash: hex32(input, 'receiptHash'),
        receiptUri: optionalHttpsUri(input),
        receiptVersion: expectedVersion,
        clientVerified: true,
        openRevealTxHash,
        revealTxHash,
        clearTxHash,
        notes: optionalText(input, 'notes', 500, MULTI_LINE_FORBIDDEN_RE),
        recordedAt: new Date().toISOString(),
      };
      return commit(
        ctx,
        current,
        updated({ ...current, status: 'provider-selected', selection }),
      );
    },

    'attach-payment-intent': async (ctx, input) => {
      assertOnly(input, ['rfqId', 'paymentIntentId']);
      const id = uuid(input);
      const current = await requireRfq(ctx, id);
      const round = current.subRosa;
      const selection = current.selection;
      if (!round || !selection) {
        throw new PluginError(
          'Record the Sub Rosa selection before attaching a payment intent',
        );
      }
      const paymentIntentId = checked(
        requireString(input, 'paymentIntentId', { max: 64 }),
        'paymentIntentId',
        CORE_ID_RE,
        'a Cosmos Pay resource id',
      );
      // A replay of the link that was made answers it again.
      if (current.paymentIntentId === paymentIntentId) return toJson(current);
      if (current.paymentIntentId !== null) {
        throw new PluginError(`RFQ ${id} already links another payment intent`);
      }
      const intent = await ctx.core.paymentIntents.get(paymentIntentId);
      if (!intent) {
        throw new PluginError(
          `Payment intent ${paymentIntentId} was not found for this tenant`,
        );
      }
      if (intent.chain !== 'stellar') {
        throw new PluginError(
          'The linked payment intent must settle on Stellar',
        );
      }
      const expectedNetwork = INTENT_NETWORK[round.network];
      if (intent.network !== expectedNetwork) {
        throw new PluginError(
          `Payment intent network must be ${expectedNetwork} for this RFQ`,
        );
      }
      if (intent.destination !== selection.selectedProviderAddress) {
        throw new PluginError(
          'The payment intent must pay the selected provider: its destination must be selectedProviderAddress',
        );
      }
      if (!LINKABLE_STATUSES.includes(intent.status)) {
        throw new PluginError(
          `A ${intent.status} payment intent cannot be linked`,
        );
      }
      return commit(ctx, current, updated({ ...current, paymentIntentId }));
    },
  },

  queries: {
    'get-rfq': async (ctx, input) => {
      assertOnly(input, ['rfqId']);
      const record = await requireRfq(ctx, uuid(input));
      const paymentIntent = record.paymentIntentId
        ? await ctx.core.paymentIntents.get(record.paymentIntentId)
        : null;
      return {
        rfq: toJson(record),
        paymentIntent: paymentIntent as unknown as PluginJson,
      };
    },

    'list-rfqs': async (ctx, input) => {
      assertOnly(input, ['take', 'after']);
      const take =
        input.take === undefined ? 50 : integer(input, 'take', 1, 100);
      const after = optionalString(input, 'after', { max: 128 });
      const page = await ctx.storage.list(COLLECTION, {
        take,
        ...(after === undefined ? {} : { after }),
      });
      return {
        data: page.items.map((item) => item.value),
        nextCursor: page.nextCursor,
      };
    },
  },
});
