import { randomBytes } from 'node:crypto';
import {
  Account,
  BASE_FEE,
  FeeBumpTransaction,
  Keypair,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import type { AccountSigners } from '@/stellar/account-signers';
import { isAccountId } from '@/stellar/account-signers';
import {
  SEP10_CHALLENGE_TTL_S,
  SEP10_NONCE_BYTES,
} from '@/recovery/recovery.constants';

/**
 * SEP-10 Stellar Web Authentication: the challenge this server hands out, and
 * what it takes for a signed one to come back accepted.
 *
 * It exists because SEP-30 authenticates with a SEP-10 token. Doing the real
 * thing rather than a signed string of our own is what lets any SEP-30 client —
 * not only ours — use these servers, and what lets our wallet use anyone's.
 *
 * ## Why a challenge can never move money
 *
 * SEQUENCE NUMBER 0. No account has sequence 0 — a real one starts at the ledger
 * it was created in — so a challenge is unsubmittable by construction, whatever
 * it contains. It carries two `manageData` operations: the first sourced by the
 * CLIENT (signing it proves control of that account) naming `<home domain> auth`
 * with 48 random bytes, the second sourced by this server naming the web-auth
 * domain, which is what stops a challenge minted for one service being replayed
 * at another.
 *
 * ## Verification, in the order it matters
 *
 * Everything structural is checked BEFORE any signature is looked at, and the
 * account's own signers and medium threshold decide how much weight is enough —
 * which is what lets a recovered account, whose master key now has weight 0,
 * authenticate with the key that replaced it. `verifyChallenge` takes the signer
 * set as an argument, so this file never touches the network.
 *
 * Ported from the developer platform, which no longer serves SEP-10. Two things
 * are stricter than the port's source: a MUXED (`M…`) client account is refused
 * rather than compared — it renders as a different string from the `G…` account
 * it wraps — and signatures are only ever counted once per signer.
 */

export interface Sep10Config {
  /** The server's SEP-10 signing key, published in its stellar.toml. */
  signingSecret: string;
  /** The domain the wallet asked to authenticate for; shared by both servers. */
  homeDomain: string;
  /** The host serving this endpoint; refuses a challenge replayed at another service. */
  webAuthDomain: string;
  networkPassphrase: string;
}

export type ChallengeFailure =
  | 'not_a_transaction'
  | 'wrong_server'
  | 'not_a_challenge'
  | 'expired'
  | 'wrong_home_domain'
  | 'wrong_web_auth_domain'
  | 'wrong_account'
  | 'server_signature'
  | 'client_signature'
  | 'below_threshold';

export type ChallengeStructure =
  | { ok: true; account: string; tx: Transaction }
  | { ok: false; error: ChallengeFailure };

export type ChallengeResult =
  { ok: true; account: string } | { ok: false; error: ChallengeFailure };

/** The challenge for `account`, signed by this server. */
export function buildChallenge(
  cfg: Sep10Config,
  account: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const server = Keypair.fromSecret(cfg.signingSecret);
  // "-1" so the builder's own increment lands on sequence 0 — the whole reason a
  // challenge cannot be submitted, whatever it carries.
  const source = new Account(server.publicKey(), '-1');

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
    timebounds: {
      minTime: nowSeconds,
      maxTime: nowSeconds + SEP10_CHALLENGE_TTL_S,
    },
    memo: Memo.none(),
  })
    .addOperation(
      Operation.manageData({
        source: account,
        name: `${cfg.homeDomain} auth`,
        // SEP-10: 48 random bytes, base64 — 64 characters, inside manageData's 64.
        value: randomBytes(SEP10_NONCE_BYTES).toString('base64'),
      }),
    )
    .addOperation(
      Operation.manageData({
        source: server.publicKey(),
        name: 'web_auth_domain',
        value: cfg.webAuthDomain,
      }),
    )
    .build();
  tx.sign(server);
  return tx.toXDR();
}

/**
 * Everything about a challenge that can be checked without a signature, and the
 * account it is for.
 *
 * Separate from `verifyChallenge` because the caller needs the account BEFORE it
 * can ask Horizon for the signer set the signatures are weighed against — and
 * because a challenge that is not ours should be refused without a network call.
 */
export function readChallenge(
  cfg: Sep10Config,
  xdr: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): ChallengeStructure {
  let tx: Transaction;
  try {
    const parsed = TransactionBuilder.fromXDR(
      xdr.trim(),
      cfg.networkPassphrase,
    );
    if (parsed instanceof FeeBumpTransaction)
      return { ok: false, error: 'not_a_transaction' };
    tx = parsed;
  } catch {
    return { ok: false, error: 'not_a_transaction' };
  }
  // An envelope does not carry its network — the passphrase only lives in what the
  // signatures commit to — so one from another network parses fine here and is
  // refused below, where this server's own signature fails to verify under ours.

  const server = Keypair.fromSecret(cfg.signingSecret).publicKey();
  if (tx.source !== server) return { ok: false, error: 'wrong_server' };
  if (tx.sequence !== '0') return { ok: false, error: 'not_a_challenge' };
  if (tx.operations.length < 2) return { ok: false, error: 'not_a_challenge' };
  if (!tx.timeBounds) return { ok: false, error: 'not_a_challenge' };
  const min = Number(tx.timeBounds.minTime);
  const max = Number(tx.timeBounds.maxTime);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === 0) {
    return { ok: false, error: 'not_a_challenge' };
  }
  if (nowSeconds < min || nowSeconds > max)
    return { ok: false, error: 'expired' };

  const [first, ...rest] = tx.operations;
  if (first.type !== 'manageData' || !first.source)
    return { ok: false, error: 'not_a_challenge' };
  if (first.name !== `${cfg.homeDomain} auth`)
    return { ok: false, error: 'wrong_home_domain' };
  const nonce = first.value ? Buffer.from(first.value).toString('utf8') : '';
  if (Buffer.from(nonce, 'base64').length !== SEP10_NONCE_BYTES) {
    return { ok: false, error: 'not_a_challenge' };
  }

  // Every later operation must be a manageData sourced by THIS server — SEP-10
  // allows others, but none of ours adds any, and one sourced by the client would
  // be a write to its account smuggled into a login. The web-auth one must name
  // this service, or a challenge collected elsewhere is replayable here.
  let sawWebAuth = false;
  for (const op of rest) {
    if (op.type !== 'manageData' || op.source !== server)
      return { ok: false, error: 'not_a_challenge' };
    if (op.name === 'web_auth_domain') {
      sawWebAuth = true;
      if (
        !op.value ||
        Buffer.from(op.value).toString('utf8') !== cfg.webAuthDomain
      ) {
        return { ok: false, error: 'wrong_web_auth_domain' };
      }
    }
  }
  if (!sawWebAuth) return { ok: false, error: 'wrong_web_auth_domain' };

  const client = first.source;
  // `isAccountId` accepts G… only: an M… source is a different string for the
  // same account, and comparing it against a registered G… address would miss.
  if (!client.startsWith('G') || !isAccountId(client))
    return { ok: false, error: 'wrong_account' };
  return { ok: true, account: client, tx };
}

/**
 * Check a signed challenge and say whose account it authenticates.
 *
 * `account` is the signer set Horizon reports; `null` for an account that does
 * not exist on the network yet, where SEP-10 says its master key alone must sign.
 */
export function verifyChallenge(
  cfg: Sep10Config,
  xdr: string,
  account: AccountSigners | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): ChallengeResult {
  const structure = readChallenge(cfg, xdr, nowSeconds);
  if (!structure.ok) return structure;
  const { tx, account: client } = structure;
  const server = Keypair.fromSecret(cfg.signingSecret).publicKey();

  const hash = tx.hash();
  const candidates = [
    server,
    ...(account ? account.signers.map((s) => s.key) : [client]),
  ];
  const verified = new Set<string>();
  for (const sig of tx.signatures) {
    for (const key of candidates) {
      if (verified.has(key)) continue;
      try {
        if (Keypair.fromPublicKey(key).verify(hash, sig.signature)) {
          verified.add(key);
          // One signature, one signer: a signature cannot be counted twice by
          // matching two entries that happen to share a key.
          break;
        }
      } catch {
        // A signer this build cannot verify with counts for nothing.
      }
    }
  }

  if (!verified.has(server)) return { ok: false, error: 'server_signature' };
  if (account === null) {
    return verified.has(client)
      ? { ok: true, account: client }
      : { ok: false, error: 'client_signature' };
  }
  const weight = account.signers
    .filter((s) => s.key !== server && verified.has(s.key))
    .reduce((n, s) => n + s.weight, 0);
  if (weight === 0) return { ok: false, error: 'client_signature' };
  // The account's own rule for "enough", so a recovered account — master key at
  // weight 0, a new device key in its place — authenticates as it should.
  if (weight < account.medThreshold)
    return { ok: false, error: 'below_threshold' };
  return { ok: true, account: client };
}
