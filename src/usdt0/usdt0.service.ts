import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, Usdt0Transfer } from '@generated/prisma/client';
import { toChecksumAddress } from '@/chains/chain-address';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { isUniqueViolation } from '@/common/prisma-errors';
import { project } from '@/common/projection';
import { PublicRecordTokens } from '@/common/public-record-token';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { resolveNetwork } from '@/common/stellar-network';
import type { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { StellarAccountLoader } from '@/stellar/account-loader.service';
import { sep7Qr, sep7TxUri } from '@/stellar/sep7';
import { SorobanRpcClient } from '@/stellar/soroban-rpc.client';
import { resolveIdempotencyKey } from '@/stellar/stellar-operation-policy';
import { fromStroops, toStroops } from '@/swaps/swap-math';
import { CreateUsdt0TransferDto } from '@/usdt0/dto/create-usdt0-transfer.dto';
import { QuoteUsdt0Dto } from '@/usdt0/dto/quote-usdt0.dto';
import { QueryUsdt0TransfersDto } from '@/usdt0/dto/query-usdt0-transfers.dto';
import type {
  Usdt0QuoteEntity,
  Usdt0RoutesEntity,
} from '@/usdt0/entities/usdt0.entity';
import { assertCanPayXlm, assertHoldsUsdt0 } from '@/usdt0/usdt0-funds';
import {
  hasLapsed,
  ledgerOutcome,
  resultCodes,
  verifySignedEnvelope,
} from '@/usdt0/usdt0-ledger';
import { Usdt0OftClient } from '@/usdt0/usdt0-oft.client';
import { type OftQuote, withFeeBuffer, withoutDust } from '@/usdt0/usdt0-oft';
import { Usdt0TransferTracker } from '@/usdt0/usdt0-transfer-tracker.service';
import {
  LAYERZERO_SCAN_TX_URL,
  STELLAR_EID,
  USDT0_ASSET_CODE,
  USDT0_CHAIN_IDS,
  USDT0_ISSUER,
  USDT0_OFT,
  USDT0_QUOTE_RECIPIENT,
  USDT0_QUOTE_SOURCE,
  USDT0_ROUTES,
  USDT0_SAC,
} from '@/usdt0/usdt0.constants';

/**
 * The columns a transfer may leave this service with. An allowlist: the row
 * also carries `consumerId` and the read throttle (`lastCheckedAt`), which no
 * caller (least of all one on the shared public key) has any use for.
 */
export const USDT0_TRANSFER_PUBLIC_SELECT = {
  id: true,
  status: true,
  network: true,
  source: true,
  to: true,
  eid: true,
  receives: true,
  recipient: true,
  amount: true,
  amountSent: true,
  amountReceived: true,
  nativeFee: true,
  nativeFeeLimit: true,
  networkFee: true,
  xdr: true,
  uri: true,
  txHash: true,
  guid: true,
  destinationTxHash: true,
  scanStatus: true,
  failureReason: true,
  idempotencyKey: true,
  expiresAt: true,
  submittedAt: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.Usdt0TransferSelect;

type PublicUsdt0Transfer = Prisma.Usdt0TransferGetPayload<{
  select: typeof USDT0_TRANSFER_PUBLIC_SELECT;
}>;

/** A transfer as the list returns it: the public row plus its derived fields. */
export type Usdt0TransferListItem = Omit<PublicUsdt0Transfer, 'txHash'> & {
  /** Null until the transaction reached the network. */
  txHash: string | null;
  dust: string;
  scanUrl: string | null;
};

/** A transfer as a single read returns it: with its QR (null when too large). */
export type Usdt0TransferView = Usdt0TransferListItem & { qr: string | null };

/** What `POST /v1/usdt0/transfers/{id}/submit` answers. */
export interface Usdt0SubmitOutcome {
  submitted: boolean;
  status: Usdt0Transfer['status'];
  txHash?: string;
  reason?: string;
  transfer: Usdt0TransferView;
}

/** The terms a stored transfer is compared on when an Idempotency-Key is reused. */
interface Usdt0RequestTerms {
  source: string;
  to: string;
  recipient: string;
  amount: string;
}

/** Statuses whose transaction reached the network, so its hash means something. */
const ON_NETWORK = new Set<Usdt0Transfer['status']>([
  'SUBMITTED',
  'DELIVERED',
  'FAILED',
]);

/**
 * USDT0 from Stellar to an EVM network, through LayerZero's OFT.
 *
 * Tether's USDT0 on Stellar is an OFT: `send` burns it here and LayerZero
 * delivers it on the destination network, as native USDT on Ethereum (the
 * peer there is Tether's OFT adapter, which unlocks real USDT) and as USDT0
 * everywhere else. This service is non-custodial, like the swaps: it quotes the
 * OFT by simulation, builds the one Soroban transaction the holder signs
 * (Freighter, or the SEP-7 link), checks the signed copy is that transaction,
 * relays it through the Soroban RPC and follows the message on LayerZero Scan
 * ({@link Usdt0TransferTracker}). The holder pays LayerZero's fee in XLM inside
 * the same transaction.
 *
 * **No Cosmos Pay commission, for now.** A Soroban transaction carries exactly
 * one operation, so no fee payment can ride along with `send` the way it does
 * in a path-payment swap; charging one would take a second transaction (and a
 * second signature) or an OFT compose call. The product owner decides; until
 * then this route moves the holder's USDT0 at LayerZero's price only.
 *
 * Mainnet only: USDT0 does not exist on Stellar testnet, so a dev key reads the
 * routes (`available: false`) and is refused everything else.
 */
@Injectable()
export class Usdt0Service {
  private readonly logger = new Logger(Usdt0Service.name);

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly accounts: StellarAccountLoader,
    private readonly rpc: SorobanRpcClient,
    private readonly oft: Usdt0OftClient,
    private readonly tracker: Usdt0TransferTracker,
    private readonly recordTokens: PublicRecordTokens,
  ) {}

  // ── Routes ────────────────────────────────────────────────────────────────
  /** The networks USDT0 can be sent to; none for a dev (testnet) key. */
  routes(consumer: GatewayConsumer): Usdt0RoutesEntity {
    const available = this.isMainnet(consumer);
    return {
      network: 'public',
      available,
      token: {
        code: USDT0_ASSET_CODE,
        issuer: USDT0_ISSUER,
        contract: USDT0_SAC,
      },
      oft: USDT0_OFT,
      eid: STELLAR_EID,
      routes: available
        ? USDT0_CHAIN_IDS.map((chain) => ({ chain, ...USDT0_ROUTES[chain] }))
        : [],
    };
  }

  // ── Quote ─────────────────────────────────────────────────────────────────
  /**
   * What sending `amount` to `to` costs and delivers, by simulating the OFT's
   * `quote_oft` and `quote_send` as `source` (or a fixed mainnet account).
   * Persists nothing.
   */
  async quote(
    consumer: GatewayConsumer,
    dto: QuoteUsdt0Dto,
  ): Promise<Usdt0QuoteEntity> {
    this.assertMainnet(consumer);
    const route = USDT0_ROUTES[dto.to];
    const amountLd = this.amountLd(dto.amount);
    const { oft, fee } = await this.oft.quote(
      dto.source ?? USDT0_QUOTE_SOURCE,
      {
        dstEid: route.eid,
        recipient: USDT0_QUOTE_RECIPIENT,
        amountLd,
      },
    );
    this.assertWithinLimits(oft);
    return {
      to: dto.to,
      eid: route.eid,
      receives: route.receives,
      amount: fromStroops(amountLd),
      amountSent: fromStroops(oft.amountSentLd),
      amountReceived: fromStroops(oft.amountReceivedLd),
      dust: fromStroops(amountLd - oft.amountSentLd),
      nativeFee: fromStroops(fee.nativeFee),
      nativeFeeLimit: fromStroops(withFeeBuffer(fee.nativeFee)),
      minAmount: fromStroops(oft.minAmountLd),
      maxAmount: fromStroops(oft.maxAmountLd),
    };
  }

  // ── Create ────────────────────────────────────────────────────────────────
  /**
   * Builds the unsigned `send` transaction and persists it, after refusing
   * what would fail on-chain: an account that does not exist, does not trust
   * USDT0 or holds too little of it, cannot pay the fees in XLM, an amount the
   * OFT cannot carry, a recipient that is not an EVM address.
   *
   * Idempotency: the same `Idempotency-Key` with the same request returns the
   * stored transfer unchanged; with a different request it is a 409. On the
   * shared public key every anonymous wallet is one consumer, so the stored
   * transfer is answered only when the request matches (see {@link replay}).
   *
   * On the shared public key the answer also carries `publicToken`, the
   * transfer's read token (`PublicRecordTokens`), the same on a replay.
   */
  async create(
    consumer: GatewayConsumer,
    dto: CreateUsdt0TransferDto,
    headerIdempotencyKey?: string,
  ): Promise<Usdt0TransferView & { publicToken?: string }> {
    return this.recordTokens.attach(
      consumer,
      'usdt0-transfer',
      await this.build(consumer, dto, headerIdempotencyKey),
    );
  }

  private async build(
    consumer: GatewayConsumer,
    dto: CreateUsdt0TransferDto,
    headerIdempotencyKey?: string,
  ): Promise<Usdt0TransferView> {
    this.assertMainnet(consumer);
    const terms = this.requestTerms(dto);
    const local = await this.consumers.resolve(consumer);
    const idempotencyKey = resolveIdempotencyKey(
      headerIdempotencyKey,
      dto.idempotencyKey,
    );
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(
        local.id,
        idempotencyKey,
      );
      if (existing) return this.replay(existing, terms, consumer);
    }

    const route = USDT0_ROUTES[dto.to];
    const amountLd = this.amountLd(dto.amount);
    const amountSentLd = withoutDust(amountLd);

    // Horizon first: it answers the cheap refusals before the RPC is asked.
    const account = await this.accounts.load('public', dto.source);
    assertHoldsUsdt0(account.balances, dto.source, amountSentLd);

    const { oft, fee } = await this.oft.quote(dto.source, {
      dstEid: route.eid,
      recipient: terms.recipient,
      amountLd,
    });
    this.assertWithinLimits(oft);
    const nativeFeeLimit = withFeeBuffer(fee.nativeFee);

    const stellar = this.config.get('stellar', { infer: true });
    const tx = await this.oft.buildSend(
      account,
      {
        dstEid: route.eid,
        recipient: terms.recipient,
        // The dust-free amount: the transaction says exactly what it takes.
        amountLd: oft.amountSentLd,
        // The floor: `send` fails on-chain rather than deliver less.
        minAmountLd: oft.amountReceivedLd,
      },
      { nativeFee: nativeFeeLimit, zroFee: 0n },
      { baseFee: stellar.baseFee, timeoutSeconds: stellar.timeoutSeconds },
    );
    const networkFee = BigInt(tx.fee);
    assertCanPayXlm(account, account.balances, {
      address: dto.source,
      nativeFeeLimit,
      networkFee,
    });

    const xdr = tx.toXDR();
    const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    const transfer = await this.persist({
      consumerId: local.id,
      network: 'public',
      status: 'PENDING',
      source: dto.source,
      to: dto.to,
      eid: route.eid,
      receives: route.receives,
      recipient: terms.recipient,
      amount: terms.amount,
      amountSent: fromStroops(oft.amountSentLd),
      amountReceived: fromStroops(oft.amountReceivedLd),
      nativeFee: fromStroops(fee.nativeFee),
      nativeFeeLimit: fromStroops(nativeFeeLimit),
      networkFee: fromStroops(networkFee),
      xdr,
      uri: sep7TxUri(xdr),
      txHash: Buffer.from(tx.hash()).toString('hex'),
      idempotencyKey,
      expiresAt: new Date(
        maxTime > 0
          ? maxTime * 1000
          : Date.now() + stellar.timeoutSeconds * 1000,
      ),
    });
    if (!transfer) {
      // Another request with the same key won the insert.
      const raced = await this.findByIdempotencyKey(local.id, idempotencyKey!);
      if (raced) return this.replay(raced, terms, consumer);
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'A USDT0 transfer with this Idempotency-Key already exists.',
      );
    }

    this.logger.log(
      `Created USDT0 transfer ${transfer.id}: ${transfer.amountSent} USDT0 ` +
        `${transfer.source} -> ${transfer.to} ${transfer.recipient} ` +
        `(fee ${transfer.nativeFee} XLM, consumer=${consumer.username})`,
    );
    return this.present(transfer);
  }

  // ── Read ──────────────────────────────────────────────────────────────────
  async findAll(
    consumer: GatewayConsumer,
    query: QueryUsdt0TransfersDto,
  ): Promise<{
    data: Usdt0TransferListItem[];
    total: number;
    take: number;
    skip: number;
  }> {
    const where = {
      consumer: { apisixUsername: consumer.username },
      // Only the network this key targets (`resolveNetwork`): a production key never lists a
      // test-network row, nor a sandbox key a mainnet one.
      // USDT0 is mainnet only (always `public`), so a sandbox key lists none.
      network: resolveNetwork(this.config, consumer),
      ...(query.status ? { status: query.status } : {}),
    };
    // `Promise.all`, not `$transaction`: see `@/common/pagination` for why.
    const [rows, total] = await Promise.all([
      this.prisma.usdt0Transfer.findMany({
        where,
        take: query.take,
        skip: query.skip,
        orderBy: { createdAt: 'desc' },
        select: USDT0_TRANSFER_PUBLIC_SELECT,
      }),
      this.prisma.usdt0Transfer.count({ where }),
    ]);
    return {
      data: rows.map((row) => this.listItem(row)),
      total,
      take: query.take,
      skip: query.skip,
    };
  }

  /**
   * One transfer, refreshed from the ledger and LayerZero Scan while it is
   * PENDING or SUBMITTED (at most once per throttle window).
   */
  async findOne(
    consumer: GatewayConsumer,
    id: string,
    recordToken?: string,
  ): Promise<Usdt0TransferView> {
    const row = await this.findOwned(consumer, id, recordToken);
    return this.present(await this.tracker.refresh(row));
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  /**
   * Relays the signed transaction through the Soroban RPC and waits for the
   * ledger. Nothing about the transfer is answered until the envelope is shown
   * to be the one built for it, signed (`verifySignedEnvelope`).
   *
   * - accepted and applied: SUBMITTED, with LayerZero's guid from `send`'s
   *   return value; accepted but not applied within the wait: SUBMITTED, and
   *   the next read settles it;
   * - applied and failed: FAILED, with the result codes;
   * - refused by the network (a bad signature, a spent sequence number): the
   *   transfer stays PENDING and `reason` says why, unless the ledger shows the
   *   same transaction already applied (a wallet that broadcast it itself);
   * - a congested or unreachable RPC: 503, the transfer stays PENDING.
   */
  async submit(
    consumer: GatewayConsumer,
    id: string,
    signedXdr: string,
    recordToken?: string,
  ): Promise<Usdt0SubmitOutcome> {
    this.assertMainnet(consumer);
    const row = await this.findOwned(consumer, id, recordToken);
    const tx = verifySignedEnvelope(signedXdr, {
      txHash: row.txHash,
      passphrase: this.rpc.passphrase,
    });

    if (row.status === 'SUBMITTED' || row.status === 'DELIVERED') {
      return this.outcome(row);
    }
    if (row.status !== 'PENDING') {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        `Cannot submit a ${row.status} USDT0 transfer. Build a new one.`,
      );
    }
    if (hasLapsed(tx, row.expiresAt)) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidStateTransition,
        "This transfer's transaction expired and can no longer be submitted. " +
          'If it reached the network before then, it will still settle. ' +
          'Otherwise build a new transfer.',
      );
    }

    const sent = await this.rpc.send(tx);
    if (sent.status === 'TRY_AGAIN_LATER') {
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        'The Stellar network did not accept the transaction now (try again ' +
          'later). Submit it again shortly.',
      );
    }
    if (sent.status === 'ERROR') {
      // A refusal of THIS broadcast says nothing about a copy the wallet
      // broadcast itself, so the ledger is asked before answering.
      const settled = await this.settleFromLedger(row);
      if (settled.status !== 'PENDING') return this.outcome(settled);
      const codes = resultCodes(sent.errorResult);
      this.logger.warn(
        `USDT0 transfer ${row.id} refused on submit (${codes.join(', ') || 'no result'})`,
      );
      return {
        submitted: false,
        status: 'PENDING',
        reason:
          'The Stellar network refused the transaction' +
          (codes.length ? ` (${codes.join(', ')})` : '') +
          '. Sign it with the account that holds the USDT0 and submit again ' +
          'before it expires, or build a new transfer.',
        transfer: await this.present(settled),
      };
    }
    // PENDING (queued) or DUPLICATE (already queued): wait for the ledger.
    return this.outcome(await this.tracker.awaitLedger(row));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  private isMainnet(consumer: GatewayConsumer): boolean {
    return resolveNetwork(this.config, consumer) === 'public';
  }

  private assertMainnet(consumer: GatewayConsumer): void {
    if (this.isMainnet(consumer)) return;
    throw ApiError.badRequest(
      ApiErrorCode.NetworkUnsupported,
      'USDT0 is on Stellar mainnet only: it does not exist on Stellar ' +
        'testnet. Use a prod API key.',
    );
  }

  /**
   * `amount` in stroops, refused when the OFT could not carry any of it: it
   * moves multiples of 0.000001 (6 shared decimals), so less than that is all
   * dust.
   */
  private amountLd(amount: string): bigint {
    let stroops: bigint;
    try {
      stroops = toStroops(amount);
    } catch {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        'amount is not a Stellar amount (at most 7 decimal places, within int64)',
      );
    }
    if (withoutDust(stroops) <= 0n) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        'amount must be at least 0.000001 USDT0: the OFT carries 6 decimals, ' +
          'and the 7th stays in the account as dust',
      );
    }
    return stroops;
  }

  /** The OFT's own limits, and an amount that arrives as something. */
  private assertWithinLimits(oft: OftQuote): void {
    if (oft.amountSentLd < oft.minAmountLd) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        `amount is below the USDT0 OFT's minimum of ${fromStroops(oft.minAmountLd)} USDT0`,
      );
    }
    if (oft.amountSentLd > oft.maxAmountLd) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        `amount is above the USDT0 OFT's maximum of ${fromStroops(oft.maxAmountLd)} USDT0`,
      );
    }
    if (oft.amountSentLd <= 0n || oft.amountReceivedLd <= 0n) {
      throw ApiError.badRequest(
        ApiErrorCode.InvalidAmount,
        'amount is too small: nothing would arrive after the OFT’s rounding and fees',
      );
    }
  }

  /**
   * The request as a stored row records it. The recipient is EIP-55, and a
   * mixed-case address whose checksum is wrong is refused: it is a typo, and
   * the USDT0 would go to whoever holds the mistyped address.
   */
  private requestTerms(dto: CreateUsdt0TransferDto): Usdt0RequestTerms {
    const checksummed = toChecksumAddress(dto.recipient);
    const hex = dto.recipient.slice(2);
    const mixedCase = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
    if (mixedCase && checksummed !== dto.recipient) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'recipient has an invalid EIP-55 checksum: check the address, or send it in lowercase',
      );
    }
    if (/^0x0{40}$/.test(dto.recipient)) {
      throw ApiError.badRequest(
        ApiErrorCode.ValidationFailed,
        'recipient must not be the zero address',
      );
    }
    return {
      source: dto.source,
      to: dto.to,
      recipient: checksummed,
      amount: fromStroops(this.amountLd(dto.amount)),
    };
  }

  /**
   * The stored transfer when the reused key came with the same request; a 409
   * when not. Answering unconditionally would hand one anonymous caller
   * another's transaction to sign, so the conflict says nothing about it.
   */
  private async replay(
    existing: Usdt0Transfer,
    terms: Usdt0RequestTerms,
    consumer: GatewayConsumer,
  ): Promise<Usdt0TransferView> {
    const same = (Object.keys(terms) as (keyof Usdt0RequestTerms)[]).every(
      (key) => existing[key] === terms[key],
    );
    if (!same) {
      this.logger.warn(
        'Idempotency-Key reused for a different USDT0 transfer request ' +
          `(transfer=${existing.id}, consumer=${consumer.username})`,
      );
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'This Idempotency-Key was already used for a different USDT0 ' +
          'transfer request. Use a new key for a new request.',
      );
    }
    return this.present(existing);
  }

  private findByIdempotencyKey(
    consumerId: string,
    idempotencyKey: string,
  ): Promise<Usdt0Transfer | null> {
    return this.prisma.usdt0Transfer.findUnique({
      where: { consumerId_idempotencyKey: { consumerId, idempotencyKey } },
    });
  }

  /**
   * Inserts a transfer. Null when the idempotency key lost a race; a 409 when
   * two keyless builds produced the same transaction (same account sequence,
   * same second).
   */
  private async persist(
    data: Prisma.Usdt0TransferUncheckedCreateInput,
  ): Promise<Usdt0Transfer | null> {
    try {
      return await this.prisma.usdt0Transfer.create({ data });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      if (data.idempotencyKey) return null;
      throw ApiError.conflict(
        ApiErrorCode.IdempotencyConflict,
        'An identical USDT0 transfer was just built from this account. Retry ' +
          'with an Idempotency-Key, or wait a second and build again.',
      );
    }
  }

  /** The ledger's answer for a PENDING row; the row as it was when it cannot answer. */
  private async settleFromLedger(row: Usdt0Transfer): Promise<Usdt0Transfer> {
    try {
      const tx = await this.rpc.getTransaction(row.txHash);
      return await this.tracker.applyLedger(row, ledgerOutcome(tx), {
        accepted: false,
      });
    } catch {
      return row;
    }
  }

  private async outcome(row: Usdt0Transfer): Promise<Usdt0SubmitOutcome> {
    const transfer = await this.present(row);
    if (row.status === 'SUBMITTED' || row.status === 'DELIVERED') {
      return {
        submitted: true,
        status: row.status,
        txHash: row.txHash,
        transfer,
      };
    }
    return {
      submitted: false,
      status: row.status,
      ...(ON_NETWORK.has(row.status) ? { txHash: row.txHash } : {}),
      reason: row.failureReason ?? `The transfer is ${row.status}.`,
      transfer,
    };
  }

  /**
   * A miss on someone else's transfer is a 404, never a 403. The shared public
   * key also needs the transfer's record token; a missing or wrong one is the
   * same 404, decided before the table is read.
   */
  private async findOwned(
    consumer: GatewayConsumer,
    id: string,
    recordToken?: string,
  ): Promise<Usdt0Transfer> {
    if (
      !this.recordTokens.admits(consumer, 'usdt0-transfer', id, recordToken)
    ) {
      throw ApiError.notFound(`USDT0 transfer ${id} not found`);
    }
    const row = await this.prisma.usdt0Transfer.findFirst({
      where: { id, consumer: { apisixUsername: consumer.username } },
    });
    if (!row) throw ApiError.notFound(`USDT0 transfer ${id} not found`);
    return row;
  }

  /** The public projection with what is derived from it. */
  private listItem(row: PublicUsdt0Transfer): Usdt0TransferListItem {
    const onNetwork = ON_NETWORK.has(row.status);
    return {
      ...row,
      txHash: onNetwork ? row.txHash : null,
      dust: fromStroops(toStroops(row.amount) - toStroops(row.amountSent)),
      // Scan knows a message only once the transaction landed successfully.
      scanUrl:
        row.status === 'SUBMITTED' ||
        row.status === 'DELIVERED' ||
        (row.status === 'FAILED' && row.guid)
          ? `${LAYERZERO_SCAN_TX_URL}/${row.txHash}`
          : null,
    };
  }

  private async present(row: Usdt0Transfer): Promise<Usdt0TransferView> {
    const item = this.listItem(project(row, USDT0_TRANSFER_PUBLIC_SELECT));
    return { ...item, qr: await qrOrNull(row.uri) };
  }
}

/**
 * The SEP-7 link's QR, or null when it does not fit one. A QR holds at most
 * 2,953 bytes, and a Soroban transaction's ledger footprint makes its XDR
 * several kilobytes (about 7,000 characters for `send`), so the link usually
 * does not fit; a wallet signs it through Freighter or the link itself.
 */
async function qrOrNull(uri: string): Promise<string | null> {
  try {
    return await sep7Qr(uri);
  } catch {
    return null;
  }
}
