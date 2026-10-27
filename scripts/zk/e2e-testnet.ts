import { randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Keypair, Networks, rpc } from '@stellar/stellar-sdk';
import { config as loadDotenv } from 'dotenv';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import configuration, {
  envFilePath,
  type AppConfig,
} from '@/config/configuration';
import { assertZkPaymentsConfigConsistent } from '@/config/zk-payments-env';
import type { PrismaService } from '@/prisma/prisma.service';
import { toStroops } from '@/swaps/swap-math';
import type { WebhookTerminalEmitter } from '@/webhooks/webhook-terminal-emitter.service';
import {
  ConfidentialSdk,
  loadConfidentialSdk,
  loadConfidentialSdkArtifacts,
  type ConfidentialSdkModule,
} from '@/zk-payments/confidential-sdk';
import { ZkCheckoutService } from '@/zk-payments/zk-checkout.service';
import { ZkNetworksService } from '@/zk-payments/zk-networks.service';
import { ZkPaymentsService } from '@/zk-payments/zk-payments.service';
import { ZK_PAYMENT_AUDITOR_ID } from '@/zk-payments/zk-payments.constants';

/**
 * The real-chain check of private payments, on Stellar TESTNET, against the token
 * `scripts/zk/deploy-testnet.ts` deployed (the `ZK_PAYMENTS_TESTNET_*` set in
 * `.env`, or `ENV_FILE`).
 *
 *   npm run zk:e2e-testnet
 *
 * With Friendbot throwaway accounts (no real funds), it:
 *
 *   1. registers a merchant and a payer on the token (register proofs in Node);
 *   2. creates the private payment through `ZkPaymentsService.create`, which checks
 *      on-chain that the merchant is registered, plus one with a slightly
 *      different amount (the wrong-amount case), and checks that a recipient
 *      with no confidential account is refused;
 *   3. deposits the gross amount, merges, and makes the two confidential
 *      transfers: the net to the merchant, the fee to the fee account;
 *   4. confirms through `ZkCheckoutService.confirm`: the wrong-amount payment
 *      is refused (`payment_transfer_mismatch`), the right one SUCCEEDS, a
 *      second confirm answers the same, and reusing the hashes on the other
 *      payment is `409 transaction_already_settled`;
 *   5. checks the merchant's receiving balance decrypts to the net amount;
 *   6. pays one with a merchant fee (paid by the payer): a third account is
 *      refused as the fee's wallet until it registers, the third transfer goes
 *      to it, confirm refuses the request without its hash and with the fee
 *      hashes swapped, then SUCCEEDS, and the wallet's receiving balance
 *      decrypts to the merchant fee.
 *
 * The services are the module's own, wired by hand: the real
 * `ConfidentialSdk` and configuration, an in-memory stand-in for the two
 * Prisma tables they touch, and a webhook emitter that records what it is
 * asked to send. No database, no HTTP server.
 */

const PASSPHRASE: string = Networks.TESTNET;
const GROSS = '25';
/** Created before the transfers, so only its amount disqualifies it. */
const WRONG_GROSS = '25.0001';
/** 1% plus 0.1 XLM of {@link GROSS}, on top: 0.35 XLM to the fee's wallet. */
const MERCHANT_FEE = { bps: 100, fixed: '0.1', paidBy: 'payer' as const };

const consumer: GatewayConsumer = {
  username: 'cosmos_zk_e2e',
  credentialId: null,
  environment: 'dev',
  role: 'admin',
  permissions: [],
  organizationId: null,
  plan: null,
  planSwapFeeBps: null,
};

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function expectApiError(
  run: () => Promise<unknown>,
  code: ApiErrorCode,
  label: string,
): Promise<ApiError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof ApiError && err.code === code) {
      const body = err.getResponse() as { message: string };
      log(`  refused as expected: ${label} -> ${code} (${body.message})`);
      return err;
    }
    throw err;
  }
  throw new Error(`ASSERTION FAILED: ${label} was not refused with ${code}`);
}

async function main(): Promise<void> {
  loadDotenv({ path: envFilePath(), quiet: true });
  assertZkPaymentsConfigConsistent(process.env);
  const config = new ConfigService<AppConfig, true>(configuration());
  const zk = config.get('zkPayments', { infer: true }).testnet;
  if (!zk) {
    throw new Error(
      'Private payments are not configured on testnet: run npm run zk:deploy-testnet first.',
    );
  }
  log(`token        ${zk.token}`);
  log(`fee account  ${zk.feeAccount}`);

  const sdk = await loadConfidentialSdk();
  const artifacts = await loadConfidentialSdkArtifacts();
  const server = new rpc.Server(zk.rpcUrl, { timeout: 30_000 });
  const client = new sdk.ChainClient({
    rpcUrl: zk.rpcUrl,
    networkPassphrase: PASSPHRASE,
    contracts: {
      token: zk.token,
      verifier: zk.verifier,
      auditor: zk.auditorRegistry,
    },
  });
  const addrF = sdk.addressToField(zk.token);
  const kAud = await client.auditorKey(ZK_PAYMENT_AUDITOR_ID);
  const startLedger = (await server.getLatestLedger()).sequence;

  // The module, wired by hand.
  const prisma = new InMemoryPrisma();
  const webhooks = new RecordingWebhooks();
  const networks = new ZkNetworksService(config);
  const confidential = new ConfidentialSdk();
  const payments = new ZkPaymentsService(
    config,
    prisma as unknown as PrismaService,
    new ConsumerResolverService(prisma as unknown as PrismaService),
    networks,
    confidential,
  );
  const checkout = new ZkCheckoutService(
    prisma as unknown as PrismaService,
    networks,
    confidential,
    webhooks as unknown as WebhookTerminalEmitter,
  );

  const registerProver = new sdk.CircuitProver(
    artifacts.loadCircuit('register'),
  );
  const transferProver = new sdk.CircuitProver(
    artifacts.loadCircuit('transfer'),
  );
  try {
    log('\n[accounts]');
    const merchant = await freshAccount(server, 'merchant');
    const payer = await freshAccount(server, 'payer');
    const merchantKeys = sdk.deriveKeys(sdk.randomScalar(), addrF);
    const payerKeys = sdk.deriveKeys(sdk.randomScalar(), addrF);

    const register = async (
      who: string,
      kp: Keypair,
      keys: ReturnType<ConfidentialSdkModule['deriveKeys']>,
    ) => {
      const witness = sdk.buildRegisterWitness(keys, kp.publicKey());
      const { proof } = await registerProver.prove(witness.inputs);
      const r = await sdk.submitRegister(
        client,
        sdk.keypairSigner(kp.secret(), PASSPHRASE),
        kp.publicKey(),
        ZK_PAYMENT_AUDITOR_ID,
        witness,
        proof,
      );
      log(`  ${who} registered: tx ${r.hash}`);
    };

    log('\n[register] merchant and payer, under auditor 0');
    await register('merchant', merchant, merchantKeys);
    await register('payer', payer, payerKeys);

    log('\n[create] through ZkPaymentsService.create');
    await expectApiError(
      () =>
        payments.create(consumer, {
          amount: GROSS,
          recipient: Keypair.random().publicKey(),
        }),
      ApiErrorCode.RecipientNotRegistered,
      'a recipient with no confidential account',
    );
    const payment = await payments.create(consumer, {
      amount: GROSS,
      recipient: merchant.publicKey(),
      description: 'ZK e2e on testnet',
      idempotencyKey: `zk-e2e-${randomBytes(4).toString('hex')}`,
    });
    log(
      `  payment ${payment.id}: amount ${payment.amount}, net ${payment.netAmount}, ` +
        `fee ${payment.feeAmount} (${payment.feeBps} bps), status ${payment.status}`,
    );
    const wrong = await payments.create(consumer, {
      amount: WRONG_GROSS,
      recipient: merchant.publicKey(),
    });
    log(`  wrong-amount payment ${wrong.id}: net ${wrong.netAmount}`);

    const publicView = await checkout.findPublic(payment.id);
    assert(publicView.status === 'PENDING', 'a new payment reads PENDING');
    assert(
      publicView.feeAccount === zk.feeAccount,
      'the checkout names the fee account',
    );

    log('\n[pay] deposit, merge, two confidential transfers');
    const payerSigner = sdk.keypairSigner(payer.secret(), PASSPHRASE);
    const gross = toStroops(publicView.amount);
    const net = toStroops(publicView.netAmount);
    const fee = toStroops(publicView.feeAmount);
    const deposit = await sdk.submitDeposit(
      client,
      payerSigner,
      payer.publicKey(),
      payer.publicKey(),
      gross,
    );
    log(`  deposit ${publicView.amount} XLM: tx ${deposit.hash}`);
    const merge = await sdk.submitMerge(client, payerSigner, payer.publicKey());
    log(`  merge: tx ${merge.hash}`);

    const payerEngine = new sdk.StateEngine({
      client,
      store: new sdk.MemoryStore(),
      keys: payerKeys,
      address: payer.publicKey(),
      fromLedger: startLedger,
    });
    const paymentTxHash = await transfer(
      sdk,
      client,
      transferProver,
      payerEngine,
      payerKeys,
      payerSigner,
      payer.publicKey(),
      publicView.recipient,
      net,
      kAud,
    );
    log(
      `  payment transfer (net ${publicView.netAmount}): tx ${paymentTxHash}`,
    );
    const feeTxHash = await transfer(
      sdk,
      client,
      transferProver,
      payerEngine,
      payerKeys,
      payerSigner,
      payer.publicKey(),
      publicView.feeAccount,
      fee,
      kAud,
    );
    log(`  fee transfer (fee ${publicView.feeAmount}): tx ${feeTxHash}`);

    log('\n[confirm] through ZkCheckoutService.confirm');
    const wrongErr = await expectApiError(
      () => checkout.confirm(wrong.id, { paymentTxHash, feeTxHash }),
      ApiErrorCode.PaymentTransferMismatch,
      'the right transfers on a payment of another amount',
    );
    assert(
      String((wrongErr.getResponse() as { message: string }).message).includes(
        'the amount is not the one this payment requires',
      ),
      'the wrong-amount refusal is the amount check, not an earlier one',
    );
    assert(
      (await checkout.findPublic(wrong.id)).status === 'PENDING',
      'a refused confirm leaves the payment PENDING',
    );
    await expectApiError(
      () =>
        checkout.confirm(payment.id, {
          paymentTxHash: feeTxHash,
          feeTxHash: paymentTxHash,
        }),
      ApiErrorCode.PaymentTransferMismatch,
      'the two hashes swapped',
    );

    const settled = await checkout.confirm(payment.id, {
      paymentTxHash,
      feeTxHash,
    });
    assert(settled.status === 'SUCCEEDED', 'the payment is SUCCEEDED');
    const owner = await payments.findOne(consumer, payment.id);
    assert(owner.status === 'SUCCEEDED', 'the owner reads SUCCEEDED');
    assert(owner.payer === payer.publicKey(), 'the payer is recorded');
    assert(owner.paymentTxHash === paymentTxHash, 'paymentTxHash is recorded');
    assert(owner.feeTxHash === feeTxHash, 'feeTxHash is recorded');
    assert(
      webhooks.events.length === 1 &&
        webhooks.events[0].type === 'ZK_PAYMENT_SUCCEEDED' &&
        webhooks.events[0].consumer === consumer.username,
      'one ZK_PAYMENT_SUCCEEDED webhook for the owner',
    );
    log(
      `  SUCCEEDED: payer ${owner.payer}, settled at ${owner.settledAt?.toISOString()}`,
    );

    const again = await checkout.confirm(payment.id, {
      paymentTxHash,
      feeTxHash,
    });
    assert(again.status === 'SUCCEEDED', 'a repeated confirm answers the same');
    assert(
      webhooks.events.length === 1 && webhooks.attempts === 2,
      'and re-emits, which the dedup claim absorbs: one delivery',
    );
    log('  confirming again answers SUCCEEDED (idempotent)');
    await expectApiError(
      () => checkout.confirm(wrong.id, { paymentTxHash, feeTxHash }),
      ApiErrorCode.TransactionAlreadySettled,
      'the same hashes on another payment',
    );

    log('\n[merchant] the receiving balance decrypts to the net amount');
    const merchantEngine = new sdk.StateEngine({
      client,
      store: new sdk.MemoryStore(),
      keys: merchantKeys,
      address: merchant.publicKey(),
      fromLedger: startLedger,
    });
    const merchantState = await merchantEngine.sync();
    assert(
      merchantState.receiving.v === net,
      `merchant receiving v=${merchantState.receiving.v}, want ${net}`,
    );
    log(`  merchant receiving = ${merchantState.receiving.v} stroops (net)`);

    log("\n[merchant fee] a third confidential transfer, to the fee's wallet");
    const feeWallet = await freshAccount(server, 'fee wallet');
    const feeWalletKeys = sdk.deriveKeys(sdk.randomScalar(), addrF);
    const withFeeRequest = {
      amount: GROSS,
      recipient: merchant.publicKey(),
      description: 'ZK e2e with a merchant fee',
      merchantFee: { ...MERCHANT_FEE, wallet: feeWallet.publicKey() },
    };
    await expectApiError(
      () => payments.create(consumer, withFeeRequest),
      ApiErrorCode.RecipientNotRegistered,
      'a merchant fee wallet with no confidential account',
    );
    await register('fee wallet', feeWallet, feeWalletKeys);
    const withFee = await payments.create(consumer, withFeeRequest);
    assert(
      withFee.merchantFee?.amount === '0.35' && withFee.amount === '25.35',
      `the payer pays 25.35 with a 0.35 merchant fee, got ${withFee.amount} / ${withFee.merchantFee?.amount}`,
    );
    log(
      `  payment ${withFee.id}: amount ${withFee.amount}, net ${withFee.netAmount}, ` +
        `fee ${withFee.feeAmount}, merchant fee ${withFee.merchantFee.amount}`,
    );
    const feeView = await checkout.findPublic(withFee.id);
    assert(feeView.merchantFee, 'the checkout names the merchant fee');
    const deposit2 = await sdk.submitDeposit(
      client,
      payerSigner,
      payer.publicKey(),
      payer.publicKey(),
      toStroops(feeView.amount),
    );
    log(`  deposit ${feeView.amount} XLM: tx ${deposit2.hash}`);
    const merge2 = await sdk.submitMerge(
      client,
      payerSigner,
      payer.publicKey(),
    );
    log(`  merge: tx ${merge2.hash}`);
    const pay = (to: string, amount: string) =>
      transfer(
        sdk,
        client,
        transferProver,
        payerEngine,
        payerKeys,
        payerSigner,
        payer.publicKey(),
        to,
        toStroops(amount),
        kAud,
      );
    const payment2 = await pay(feeView.recipient, feeView.netAmount);
    log(`  payment transfer (net ${feeView.netAmount}): tx ${payment2}`);
    const fee2 = await pay(feeView.feeAccount, feeView.feeAmount);
    log(`  fee transfer (fee ${feeView.feeAmount}): tx ${fee2}`);
    const merchantFee2 = await pay(
      feeView.merchantFee.wallet,
      feeView.merchantFee.amount,
    );
    log(
      `  merchant fee transfer (${feeView.merchantFee.amount}): tx ${merchantFee2}`,
    );

    await expectApiError(
      () =>
        checkout.confirm(withFee.id, {
          paymentTxHash: payment2,
          feeTxHash: fee2,
        }),
      ApiErrorCode.ValidationFailed,
      'a confirm without the merchant fee transaction',
    );
    await expectApiError(
      () =>
        checkout.confirm(withFee.id, {
          paymentTxHash: payment2,
          feeTxHash: merchantFee2,
          merchantFeeTxHash: fee2,
        }),
      ApiErrorCode.FeeTransferMismatch,
      'the fee and merchant fee hashes swapped',
    );
    const settledWithFee = await checkout.confirm(withFee.id, {
      paymentTxHash: payment2,
      feeTxHash: fee2,
      merchantFeeTxHash: merchantFee2,
    });
    assert(
      settledWithFee.status === 'SUCCEEDED',
      'the payment with a merchant fee is SUCCEEDED',
    );
    const ownerWithFee = await payments.findOne(consumer, withFee.id);
    assert(
      ownerWithFee.merchantFeeTxHash === merchantFee2,
      'merchantFeeTxHash is recorded',
    );
    const feeWalletState = await new sdk.StateEngine({
      client,
      store: new sdk.MemoryStore(),
      keys: feeWalletKeys,
      address: feeWallet.publicKey(),
      fromLedger: startLedger,
    }).sync();
    const merchantFeeStroops = toStroops(feeView.merchantFee.amount);
    assert(
      feeWalletState.receiving.v === merchantFeeStroops,
      `fee wallet receiving v=${feeWalletState.receiving.v}, want ${merchantFeeStroops}`,
    );
    log(
      `  SUCCEEDED; fee wallet receiving = ${feeWalletState.receiving.v} stroops (the merchant fee)`,
    );

    log('\nprivate payments e2e on testnet: PASSED');
    log(`  payment tx ${paymentTxHash}`);
    log(`  fee tx     ${feeTxHash}`);
    log(`  merchant fee tx ${merchantFee2}`);
  } finally {
    await Promise.all([registerProver.destroy(), transferProver.destroy()]);
  }
}

async function freshAccount(server: rpc.Server, label: string) {
  const kp = Keypair.random();
  await server.fundAddress(kp.publicKey());
  log(`  ${label} = ${kp.publicKey()}`);
  return kp;
}

/** One confidential transfer from the payer's verified spendable opening. */
async function transfer(
  sdk: ConfidentialSdkModule,
  client: InstanceType<ConfidentialSdkModule['ChainClient']>,
  prover: InstanceType<ConfidentialSdkModule['CircuitProver']>,
  engine: InstanceType<ConfidentialSdkModule['StateEngine']>,
  keys: ReturnType<ConfidentialSdkModule['deriveKeys']>,
  signer: ReturnType<ConfidentialSdkModule['keypairSigner']>,
  from: string,
  to: string,
  amount: bigint,
  kAud: Awaited<
    ReturnType<InstanceType<ConfidentialSdkModule['ChainClient']>['auditorKey']>
  >,
): Promise<string> {
  // The recipient's public viewing key, read from the chain as a wallet would.
  const recipient = await client.confidentialBalance(to);
  if (!recipient) throw new Error(`${to} is not registered on the token`);
  await engine.sync();
  const { v, r } = await engine.spendableForProof();
  const witness = sdk.buildTransferWitness({
    keys,
    v,
    r,
    amount,
    pvkB: recipient.viewingPublicKey,
    kAudR: kAud,
    kAudS: kAud,
  });
  const { proof } = await prover.prove(witness.inputs);
  const result = await sdk.submitTransfer(
    client,
    signer,
    from,
    to,
    witness,
    proof,
  );
  return result.hash;
}

// -- In-memory stand-ins -----------------------------------------------------

type Row = Record<string, unknown> & { id: string };

class UniqueViolation extends Error {
  readonly code = 'P2002';
}

/**
 * The slice of Prisma the two services use, over two arrays: enough to run
 * their real logic (including the unique indexes) without a database.
 */
class InMemoryPrisma {
  private readonly consumers: Row[] = [];
  private readonly payments: Row[] = [];
  private seq = 0;

  readonly consumer = {
    upsert: (args: {
      where: { apisixUsername: string };
      create: Record<string, unknown>;
    }) => {
      let row = this.consumers.find(
        (c) => c.apisixUsername === args.where.apisixUsername,
      );
      if (!row) {
        row = { id: `consumer_${++this.seq}`, ...args.create };
        this.consumers.push(row);
      }
      return Promise.resolve(row);
    },
  };

  readonly zkPayment = {
    create: ({ data }: { data: Record<string, unknown> }) => {
      const now = new Date();
      const row: Row = {
        id: `zkp_e2e_${++this.seq}`,
        status: 'PENDING',
        payer: null,
        paymentTxHash: null,
        feeTxHash: null,
        merchantFee: null,
        merchantFeeTxHash: null,
        settledAt: null,
        description: null,
        createdAt: now,
        updatedAt: now,
        ...data,
      };
      this.assertUnique(row);
      this.payments.push(row);
      return Promise.resolve({ ...row });
    },
    findUnique: (args: {
      where: {
        id?: string;
        consumerId_idempotencyKey?: {
          consumerId: string;
          idempotencyKey: string;
        };
      };
      select?: Record<string, unknown>;
    }) => {
      const key = args.where.consumerId_idempotencyKey;
      const row = this.payments.find((p) =>
        key
          ? p.consumerId === key.consumerId &&
            p.idempotencyKey === key.idempotencyKey
          : p.id === args.where.id,
      );
      return Promise.resolve(row ? this.pick(row, args.select) : null);
    },
    findUniqueOrThrow: (args: {
      where: { id: string };
      select?: Record<string, unknown>;
    }) => {
      const row = this.payments.find((p) => p.id === args.where.id);
      if (!row) throw new Error(`No private payment ${args.where.id}`);
      return Promise.resolve(this.pick(row, args.select));
    },
    findFirst: (args: {
      where: {
        id?: string | { not: string };
        consumer?: { apisixUsername: string };
        OR?: Array<Record<string, { in: string[] }>>;
      };
      select?: Record<string, unknown>;
    }) => {
      const row = this.payments.find((p) => this.matches(p, args.where));
      return Promise.resolve(row ? this.pick(row, args.select) : null);
    },
    updateMany: (args: {
      where: { id: string; status: string };
      data: Record<string, unknown>;
    }) => {
      const row = this.payments.find(
        (p) => p.id === args.where.id && p.status === args.where.status,
      );
      if (!row) return Promise.resolve({ count: 0 });
      const next = { ...row, ...args.data, updatedAt: new Date() };
      this.assertUnique(next);
      Object.assign(row, next);
      return Promise.resolve({ count: 1 });
    },
  };

  private matches(
    row: Row,
    where: {
      id?: string | { not: string };
      consumer?: { apisixUsername: string };
      OR?: Array<Record<string, { in: string[] }>>;
    },
  ): boolean {
    if (typeof where.id === 'string' && row.id !== where.id) return false;
    if (typeof where.id === 'object' && row.id === where.id.not) return false;
    if (where.consumer) {
      const owner = this.consumers.find((c) => c.id === row.consumerId);
      if (owner?.apisixUsername !== where.consumer.apisixUsername) return false;
    }
    if (where.OR) {
      return where.OR.some((clause) =>
        Object.entries(clause).every(([column, cond]) =>
          cond.in.includes(row[column] as string),
        ),
      );
    }
    return true;
  }

  private pick(row: Row, select?: Record<string, unknown>) {
    if (!select) return { ...row };
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(select)) {
      if (key === 'consumer') {
        const owner = this.consumers.find((c) => c.id === row.consumerId);
        out.consumer = { apisixUsername: owner?.apisixUsername };
      } else {
        out[key] = row[key];
      }
    }
    return out;
  }

  private assertUnique(candidate: Row): void {
    for (const other of this.payments) {
      if (other.id === candidate.id) continue;
      const clash =
        (other.consumerId === candidate.consumerId &&
          other.idempotencyKey === candidate.idempotencyKey) ||
        (candidate.paymentTxHash != null &&
          other.paymentTxHash === candidate.paymentTxHash) ||
        (candidate.feeTxHash != null &&
          other.feeTxHash === candidate.feeTxHash) ||
        (candidate.merchantFeeTxHash != null &&
          other.merchantFeeTxHash === candidate.merchantFeeTxHash);
      if (clash) throw new UniqueViolation('unique constraint');
    }
  }
}

/** Records each webhook it is asked to emit. */
class RecordingWebhooks {
  /** What was delivered: one entry per event, as the real emitter's claim allows. */
  readonly events: Array<{ consumer: string; type: string; data: unknown }> =
    [];
  /** Every emit asked for, duplicates included. */
  attempts = 0;
  private readonly claimed = new Set<string>();

  /** Deduplicates on `type:id`, like `WebhookTerminalEmitter`'s claim key. */
  emit(consumer: string, type: string, data: unknown): Promise<boolean> {
    this.attempts++;
    const key = `${type}:${(data as { id: string }).id}:0`;
    if (this.claimed.has(key)) return Promise.resolve(false);
    this.claimed.add(key);
    this.events.push({ consumer, type, data });
    return Promise.resolve(true);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `\nprivate payments e2e on testnet FAILED: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }\n`,
  );
  process.exit(1);
});
