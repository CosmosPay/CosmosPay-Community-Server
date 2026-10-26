/**
 * Constants for USDT0 transfers from Stellar: Tether's omnichain USDT, sent
 * through LayerZero's OFT contract on Stellar mainnet to an EVM network.
 *
 * Every address and endpoint id below was read from Stellar mainnet by
 * simulation on 2026-10-25 (the OFT's `token()`, `peer(eid)`,
 * `shared_decimals()` and `decimal_conversion_rate()`), not copied from a
 * third party. USDT0 does not exist on Stellar testnet.
 */

/** The classic asset, as the asset registry lists it (`assets.constants.ts`). */
export const USDT0_ASSET_CODE = 'USDT0';
export const USDT0_ISSUER =
  'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q';
/** USDT0's Stellar Asset Contract: what the OFT burns from the sender. */
export const USDT0_SAC =
  'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF';
/** The OFT contract the transaction calls (`send`), a `MintBurn` OFT over the SAC. */
export const USDT0_OFT =
  'CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6';
/** LayerZero EndpointV2 on Stellar: it charges the messaging fee in XLM. */
export const LAYERZERO_ENDPOINT_STELLAR =
  'CCQLLRE5JBAWYCW3KTWOIWLMFDUOKROQVZNSALQMGOSXNW3ERUOWTZGK';
/** Stellar mainnet's LayerZero endpoint id. */
export const STELLAR_EID = 30600;

/**
 * The OFT's `decimal_conversion_rate()`: the SAC has 7 decimals and the OFT
 * shares 6 across chains, so an amount travels in multiples of 10 stroops and
 * the last stroop is dust. `quote_oft` drops it (`amount_sent_ld`), and the
 * dust stays in the sender's account.
 */
export const USDT0_DECIMAL_CONVERSION_RATE = 10n;

/**
 * Who signs the quote simulations when the caller names no `source`. A
 * simulation needs a source account but no signature; the issuer exists on
 * mainnet for as long as the asset does (its master key is locked at weight 0),
 * and the OFT quotes it like any holder.
 */
export const USDT0_QUOTE_SOURCE = USDT0_ISSUER;

/**
 * The recipient a quote is simulated for when there is none yet. A quote is a
 * simulation, so nothing is ever sent to it; the OFT's fee and receipt do not
 * depend on the recipient (every EVM address is the same 32 bytes long).
 */
export const USDT0_QUOTE_RECIPIENT =
  '0x000000000000000000000000000000000000dEaD';

/**
 * The buffer added to LayerZero's quoted `native_fee` before it goes into
 * `send`, in basis points (2000 = 20%).
 *
 * Why there is one: the transaction is built now and lands minutes later, after
 * the holder signs (up to `STELLAR_TX_TIMEOUT`, 300 s by default). LayerZero's
 * fee follows its price feeds (XLM against the destination's gas), and a `send`
 * that offers less than the fee at the moment it executes fails on-chain, which
 * costs the holder the Stellar network fee (about 1.45 XLM of Soroban
 * resources on the Ethereum route) and a new transaction.
 *
 * Why it costs nothing: the endpoint charges the real fee and refunds the rest
 * to `refund_address`, which is the source, inside the same transaction. A
 * mainnet simulation on 2026-10-25 showed it: a 20% buffer over a 3.6664143 XLM
 * quote moved 4.3996971 XLM to the endpoint and 0.7332828 XLM straight back.
 * The only cost is that the account must HOLD the buffer for that moment, which
 * the balance check prices in.
 *
 * Why 20%: the fee moved from 3.55 to 11.95 XLM over a month in 2026, but
 * within one envelope's lifetime it moves by a few percent; a fifth covers a
 * sharp move without asking a holder for much more XLM than the fee itself.
 */
export const USDT0_NATIVE_FEE_BUFFER_BPS = 2000n;

/** What arrives on the destination network. */
export type Usdt0Receives = 'USDT' | 'USDT0';

/** One network USDT0 can be sent to from Stellar. */
export interface Usdt0Route {
  /** Display name. */
  name: string;
  /** LayerZero endpoint id: `dst_eid` in the OFT's `SendParam`. */
  eid: number;
  /**
   * `USDT` on Ethereum, where the peer is Tether's OFT adapter and unlocks
   * native USDT; `USDT0` everywhere else, minted by that network's OFT.
   */
  receives: Usdt0Receives;
}

/**
 * The networks this service sends USDT0 to, by the id requests name them with
 * (the ids cross-chain swaps use where both exist). Exactly the endpoint ids
 * the OFT has a `peer` for on 2026-10-25, all of them EVM networks, so every
 * recipient is an EVM address. IOTA (30423), Tron (30420), TON (30343), Solana
 * (30168) and Celo (30125) have USDT0 but no peer on Stellar's OFT yet, so they
 * are not offered: a `send` there would fail on-chain (`Error(Contract, #2001)`).
 *
 * In the order the routes endpoint lists them: Ethereum first, then by name.
 */
export const USDT0_ROUTES = {
  eth: { name: 'Ethereum', eid: 30101, receives: 'USDT' },
  arb: { name: 'Arbitrum', eid: 30110, receives: 'USDT0' },
  bera: { name: 'Berachain', eid: 30362, receives: 'USDT0' },
  conflux: { name: 'Conflux eSpace', eid: 30212, receives: 'USDT0' },
  flare: { name: 'Flare', eid: 30295, receives: 'USDT0' },
  hedera: { name: 'Hedera', eid: 30316, receives: 'USDT0' },
  hyperevm: { name: 'HyperEVM', eid: 30367, receives: 'USDT0' },
  ink: { name: 'Ink', eid: 30339, receives: 'USDT0' },
  mantle: { name: 'Mantle', eid: 30181, receives: 'USDT0' },
  megaeth: { name: 'MegaETH', eid: 30398, receives: 'USDT0' },
  monad: { name: 'Monad', eid: 30390, receives: 'USDT0' },
  morph: { name: 'Morph', eid: 30322, receives: 'USDT0' },
  op: { name: 'Optimism', eid: 30111, receives: 'USDT0' },
  plasma: { name: 'Plasma', eid: 30383, receives: 'USDT0' },
  pol: { name: 'Polygon', eid: 30109, receives: 'USDT0' },
  rootstock: { name: 'Rootstock', eid: 30333, receives: 'USDT0' },
  sei: { name: 'Sei', eid: 30280, receives: 'USDT0' },
  stable: { name: 'Stable', eid: 30396, receives: 'USDT0' },
  tempo: { name: 'Tempo', eid: 30410, receives: 'USDT0' },
  unichain: { name: 'Unichain', eid: 30320, receives: 'USDT0' },
  xlayer: { name: 'X Layer', eid: 30274, receives: 'USDT0' },
} as const satisfies Record<string, Usdt0Route>;

export type Usdt0ChainId = keyof typeof USDT0_ROUTES;

/** Every route id, in the order the routes endpoint lists them. */
export const USDT0_CHAIN_IDS = Object.keys(USDT0_ROUTES) as Usdt0ChainId[];

/** LayerZero Scan's public API (no key). */
export const LAYERZERO_SCAN_API_URL = 'https://scan.layerzero-api.com/v1';

/** LayerZero Scan's page for a source transaction: `${…}/<Stellar tx hash>`. */
export const LAYERZERO_SCAN_TX_URL = 'https://layerzeroscan.com/tx';

/**
 * Budget for one LayerZero Scan call. A read of one message; slower than this
 * is Scan in trouble, and the read that asked answers from the stored row.
 */
export const LAYERZERO_SCAN_TIMEOUT_MS = 10_000;

/**
 * How often a read of one transfer may ask the ledger or LayerZero Scan about
 * it. `GET /v1/usdt0/transfers/{id}` reaches the shared public key and a wallet
 * polls it while the message travels: about 27 minutes on every route (the
 * 45 transfers from Stellar LayerZero Scan listed on 2026-10-25 took 1,612 to
 * 1,661 seconds, LayerZero's verifiers waiting for Stellar confirmations).
 * Fifteen seconds bounds what one transfer costs upstream however fast it is
 * polled.
 */
export const USDT0_STATUS_REFRESH_MS = 15_000;

/**
 * How long past its `expiresAt` a PENDING transfer must stay unseen on the
 * ledger before it reads as EXPIRED. The time bounds close at `expiresAt`, but
 * a transaction applied in the last ledger before it can take a few seconds to
 * show up at the RPC.
 */
export const USDT0_EXPIRY_GRACE_MS = 60_000;

/**
 * How long `POST /v1/usdt0/transfers/{id}/submit` waits for the ledger after
 * the RPC accepts the transaction, and how often it asks. A ledger closes every
 * five to six seconds, so thirty seconds is several of them; a transaction not
 * applied by then is left SUBMITTED, and the next read settles it.
 */
export const USDT0_SUBMIT_WAIT_MS = 30_000;
export const USDT0_SUBMIT_POLL_MS = 2_000;

/**
 * Budget for `POST /v1/usdt0/quote`, per consumer + client address. Two
 * simulations at a public RPC the whole deployment shares, on a route the
 * shared public key reaches: sixty a minute is a price refreshed once a second.
 */
export const USDT0_QUOTE_RATE_LIMIT = {
  name: 'usdt0:quote',
  limit: 60,
  windowMs: 60 * 1000,
};

/**
 * Budget for `POST /v1/usdt0/transfers`, per consumer + client address. Each
 * build is two Horizon reads, three simulations and a row; twenty a minute is
 * several honest transfers at once from one address, and bounds a builder
 * that never signs the same way swaps are bounded.
 */
export const USDT0_CREATE_RATE_LIMIT = {
  name: 'usdt0:create',
  limit: 20,
  windowMs: 60 * 1000,
};

/**
 * Budget for `POST /v1/usdt0/transfers/{id}/submit`, per consumer + client
 * address. A submission and up to {@link USDT0_SUBMIT_WAIT_MS} of polling at
 * the RPC; an honest wallet submits once and retries a few times.
 */
export const USDT0_SUBMIT_RATE_LIMIT = {
  name: 'usdt0:submit',
  limit: 20,
  windowMs: 60 * 1000,
};

/**
 * SHA-256 of `contracts/soroban/merchant-fee-oft/merchant_fee_oft.wasm`, the
 * wrapper a USDT0 transfer with a merchant fee invokes: it pays the fee in
 * USDT0, then calls the OFT's `send` and answers its receipt, all under the
 * holder's one authorization. The configured contract
 * (`USDT0_MERCHANT_FEE_WRAPPER`) must run this code and be bound to
 * {@link USDT0_OFT} and {@link USDT0_SAC} before a holder is handed a
 * transaction calling it. A changed wrapper is a new wasm, a new hash and a new
 * deployment.
 */
export const USDT0_MERCHANT_FEE_WRAPPER_WASM_SHA256 =
  '3f56cc9ed67a89be1140cc749b3fbaa322fb5afa7c710eeb04cd135d153ce21b';
