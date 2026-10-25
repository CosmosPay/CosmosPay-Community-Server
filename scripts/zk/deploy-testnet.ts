import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { config as loadDotenv } from 'dotenv';
import {
  loadConfidentialSdk,
  loadConfidentialSdkArtifacts,
  type ConfidentialSdkModule,
} from '@/zk-payments/confidential-sdk';
import { ZK_PAYMENT_AUDITOR_ID } from '@/zk-payments/zk-payments.constants';
import { DEFAULT_ZK_PAYMENTS_RPC } from '@/config/config.constants';
import { zkPaymentsEnvName } from '@/config/zk-payments-env';

/**
 * Deploys Cosmos Pay's ZK payments setup on Stellar TESTNET, and prints (or
 * writes) the `ZK_PAYMENTS_TESTNET_*` variables the server reads.
 *
 *   npm run zk:deploy-testnet
 *   npm run zk:deploy-testnet -- --env-file .env --secrets-file .zk-secrets/testnet.json
 *   npm run zk:deploy-testnet -- --redeploy
 *
 * What it does, with a Friendbot-funded throwaway deployer (no real funds,
 * testnet only):
 *
 *   1. Reads the wasm hashes of the demo's auditor registry and vanilla
 *      confidential token (stellar-confidential 0.8.0) from their instances on
 *      testnet: no Rust build, the code is already on the ledger.
 *   2. Deploys a NEW auditor registry from that wasm (admin = manager =
 *      deployer) and registers Cosmos Pay's auditor key under id 0:
 *      K_aud = k*H for a fresh scalar k (H, not G: R_e = r_e*H, so only an
 *      H-multiple makes ecdh(k, R_e) the secret the sender used).
 *   3. Deploys a NEW vanilla confidential token wrapping native XLM, with the
 *      demo's verifier registry (its v0.8.0 verification keys are registered,
 *      and verifying is public) and the new auditor registry.
 *   4. Checks addr_f parity: the token's emitted address-as-field must equal
 *      the SDK's `addressToField(token)`, or every register proof would fail.
 *   5. Creates the fee account (Friendbot) and registers it on the token under
 *      auditor 0, with a register proof generated here (bb.js, UltraHonk).
 *   6. Prints the env values. The auditor secret and the operator's keys (the
 *      registry admin, the fee account's Stellar secret and confidential
 *      spending scalar, needed to withdraw collected fees) are secrets: with
 *      `--env-file` / `--secrets-file` they are written to those files instead
 *      of the terminal. Never commit either file.
 *
 * Idempotent where it can be: when the env file already holds a complete
 * testnet set, the script verifies it on-chain (token, auditor key id 0 = k*H,
 * fee account registered under auditor 0) and stops. `--redeploy` deploys a
 * fresh set instead, which strands every payment made on the old token.
 */

const NETWORK = 'testnet' as const;
const PASSPHRASE: string = Networks.TESTNET;

/** stellar-confidential 0.8.0 instances the demo deployed on testnet. */
const DEMO_AUDITOR_REGISTRY =
  'CBQZRK72Y6KJ5DR4CUHKLHMHIKBMOZNSYTWHRUQPEXA35PRCBMSPBZTW';
const DEMO_VANILLA_TOKEN =
  'CA642WUED6PACAQGVKSXND3DRSXGR7DP2L7TRHZORPWEPNRVGGN4L4ED';
/** The demo's verifier registry, reused: its v0.8.0 VKs are registered. */
const VERIFIER = 'CAN45PFA5CVUCU3JB77IE2JNWNTRCDWMRNG55U452L3N2IOCAGOLTUVQ';

interface Options {
  envFile: string | null;
  secretsFile: string | null;
  redeploy: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    envFile: null,
    secretsFile: null,
    redeploy: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--redeploy') options.redeploy = true;
    else if (arg === '--env-file') options.envFile = argv[++i] ?? null;
    else if (arg === '--secrets-file') options.secretsFile = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.envFile) {
    loadDotenv({ path: options.envFile, quiet: true });
  }
  const rpcUrl =
    process.env[zkPaymentsEnvName(NETWORK, 'rpcUrl')]?.trim() ||
    DEFAULT_ZK_PAYMENTS_RPC[NETWORK];
  const server = new rpc.Server(rpcUrl, { timeout: 30_000 });
  const network = await server.getNetwork();
  if (network.passphrase !== PASSPHRASE) {
    throw new Error(
      `${rpcUrl} serves "${network.passphrase}", not testnet. Refusing.`,
    );
  }

  const sdk = await loadConfidentialSdk();

  if (!options.redeploy && existingSetComplete()) {
    log('A complete ZK_PAYMENTS_TESTNET_* set is configured; verifying it.');
    await verifyExisting(sdk, rpcUrl);
    log('\nThe configured deployment is live and consistent. Nothing to do.');
    log('Run with --redeploy to deploy a fresh set instead.');
    return;
  }

  // 1. The deployer: a throwaway testnet key, funded by Friendbot.
  const deployer = Keypair.random();
  await server.fundAddress(deployer.publicKey());
  log(`deployer          ${deployer.publicKey()}`);

  // The wasm already on testnet, hashed from the demo's own instances.
  const auditorWasm = await wasmHashOf(server, DEMO_AUDITOR_REGISTRY);
  const tokenWasm = await wasmHashOf(server, DEMO_VANILLA_TOKEN);
  await wasmHashOf(server, VERIFIER); // the verifier must exist
  log(`auditor wasm      ${auditorWasm.toString('hex')}`);
  log(`token wasm        ${tokenWasm.toString('hex')}`);

  // 2. Our own auditor registry, and our key under id 0.
  const deployerAddress = new Address(deployer.publicKey());
  const auditorRegistry = await deploy(server, deployer, auditorWasm, [
    deployerAddress.toScVal(),
    deployerAddress.toScVal(),
  ]);
  log(`auditor registry  ${auditorRegistry}`);

  const auditorSecret = sdk.randomScalar();
  const kAud = sdk.auditorPublicKey(auditorSecret);
  await submit(
    server,
    deployer,
    new Contract(auditorRegistry).call(
      'register_key',
      xdr.ScVal.scvU32(ZK_PAYMENT_AUDITOR_ID),
      xdr.ScVal.scvBytes(Buffer.from(sdk.pointToBytes(kAud))),
      deployerAddress.toScVal(),
    ),
  );
  log(`auditor key       registered under id ${ZK_PAYMENT_AUDITOR_ID}`);

  // 3. The token: native XLM, the demo's verifier, our auditor registry.
  const underlying = Asset.native().contractId(PASSPHRASE);
  const deployedAtLedger = (await server.getLatestLedger()).sequence;
  const token = await deploy(server, deployer, tokenWasm, [
    new Address(underlying).toScVal(),
    new Address(VERIFIER).toScVal(),
    new Address(auditorRegistry).toScVal(),
  ]);
  log(`token             ${token}`);
  log(`underlying (XLM)  ${underlying}`);
  log(`deployed at       ledger ${deployedAtLedger}`);

  // 4. addr_f parity, as the demo's deploy checks it.
  const addrF = sdk.addressToField(token);
  const onChainAddrF = await readAddressAsField(
    server,
    sdk,
    token,
    deployedAtLedger,
  );
  if (onChainAddrF === null) {
    throw new Error(
      'The token emitted no address_as_field_set event: cannot check addr_f parity.',
    );
  }
  if (onChainAddrF !== addrF) {
    throw new Error(
      `addr_f MISMATCH: SDK ${sdk.toHex32(addrF)} != contract ` +
        `${sdk.toHex32(onChainAddrF)}. Register proofs would fail.`,
    );
  }
  log(`addr_f parity     OK (${sdk.toHex32(addrF)})`);

  // 5. The fee account, registered on the token under auditor 0.
  const client = new sdk.ChainClient({
    rpcUrl,
    networkPassphrase: PASSPHRASE,
    contracts: { token, verifier: VERIFIER, auditor: auditorRegistry },
  });
  const feeAccount = Keypair.random();
  await server.fundAddress(feeAccount.publicKey());
  const feeSpendingScalar = sdk.randomScalar();
  const feeKeys = sdk.deriveKeys(feeSpendingScalar, addrF);
  const artifacts = await loadConfidentialSdkArtifacts();
  const prover = new sdk.CircuitProver(artifacts.loadCircuit('register'));
  try {
    log('fee account       proving register (bb.js, takes a while)...');
    const witness = sdk.buildRegisterWitness(feeKeys, feeAccount.publicKey());
    const { proof } = await prover.prove(witness.inputs);
    const registered = await sdk.submitRegister(
      client,
      sdk.keypairSigner(feeAccount.secret(), PASSPHRASE),
      feeAccount.publicKey(),
      ZK_PAYMENT_AUDITOR_ID,
      witness,
      proof,
    );
    log(`fee account       ${feeAccount.publicKey()} (tx ${registered.hash})`);
  } finally {
    await prover.destroy();
  }

  // Read everything back before handing it out.
  const account = await client.confidentialBalance(feeAccount.publicKey());
  if (!account || account.auditorId !== ZK_PAYMENT_AUDITOR_ID) {
    throw new Error('The fee account is not registered under auditor 0.');
  }
  if (!(await client.auditorKey(ZK_PAYMENT_AUDITOR_ID)).equals(kAud)) {
    throw new Error('The auditor registry does not hold our key under id 0.');
  }

  // 6. The values.
  const serverEnv: Record<string, string> = {
    [zkPaymentsEnvName(NETWORK, 'rpcUrl')]: rpcUrl,
    [zkPaymentsEnvName(NETWORK, 'token')]: token,
    [zkPaymentsEnvName(NETWORK, 'auditorRegistry')]: auditorRegistry,
    [zkPaymentsEnvName(NETWORK, 'verifier')]: VERIFIER,
    [zkPaymentsEnvName(NETWORK, 'auditorSecret')]: sdk
      .toHex32(auditorSecret)
      .replace(/^0x/, ''),
    [zkPaymentsEnvName(NETWORK, 'feeAccount')]: feeAccount.publicKey(),
    [zkPaymentsEnvName(NETWORK, 'deployedAtLedger')]: String(deployedAtLedger),
  };
  const operatorSecrets = {
    network: NETWORK,
    note:
      'Testnet only. The deployer is the auditor registry admin and manager ' +
      '(it can rotate key id 0). The fee account secret and its confidential ' +
      'spending scalar are what withdraws collected fees. The server needs none of these.',
    token,
    auditorRegistry,
    deployer: { publicKey: deployer.publicKey(), secret: deployer.secret() },
    feeAccount: {
      publicKey: feeAccount.publicKey(),
      secret: feeAccount.secret(),
      confidentialSpendingScalar: sdk.toHex32(feeSpendingScalar),
    },
  };

  if (options.envFile) {
    upsertEnv(options.envFile, serverEnv);
    log(`\nWrote ${Object.keys(serverEnv).join(', ')} to ${options.envFile}.`);
  } else {
    log('\n# Server environment (the auditor secret is a secret):');
    for (const [name, value] of Object.entries(serverEnv)) {
      log(`${name}=${value}`);
    }
  }
  if (options.secretsFile) {
    writeSecrets(options.secretsFile, operatorSecrets);
    log(`Wrote the operator secrets to ${options.secretsFile}.`);
  } else {
    log('\n# Operator secrets: store them, never in the repository:');
    log(JSON.stringify(operatorSecrets, null, 2));
  }
}

/** Whether the env holds every required testnet variable. */
function existingSetComplete(): boolean {
  return (
    [
      'token',
      'auditorRegistry',
      'verifier',
      'auditorSecret',
      'feeAccount',
      'deployedAtLedger',
    ] as const
  ).every((field) => process.env[zkPaymentsEnvName(NETWORK, field)]?.trim());
}

/** Checks a configured set against the chain, instead of redeploying it. */
async function verifyExisting(
  sdk: ConfidentialSdkModule,
  rpcUrl: string,
): Promise<void> {
  const env = (field: Parameters<typeof zkPaymentsEnvName>[1]) =>
    process.env[zkPaymentsEnvName(NETWORK, field)]!.trim();
  const client = new sdk.ChainClient({
    rpcUrl,
    networkPassphrase: PASSPHRASE,
    contracts: {
      token: env('token'),
      verifier: env('verifier'),
      auditor: env('auditorRegistry'),
    },
  });
  const secret = BigInt(`0x${env('auditorSecret').replace(/^0x/i, '')}`);
  const onChainKey = await client.auditorKey(ZK_PAYMENT_AUDITOR_ID);
  if (!onChainKey.equals(sdk.auditorPublicKey(secret))) {
    throw new Error(
      `${zkPaymentsEnvName(NETWORK, 'auditorSecret')} is not the key registered ` +
        `under auditor id ${ZK_PAYMENT_AUDITOR_ID}.`,
    );
  }
  log(`auditor key       id ${ZK_PAYMENT_AUDITOR_ID} matches the secret`);
  const fee = await client.confidentialBalance(env('feeAccount'));
  if (!fee || fee.auditorId !== ZK_PAYMENT_AUDITOR_ID) {
    throw new Error(
      `${env('feeAccount')} is not registered on the token under auditor 0.`,
    );
  }
  log(`fee account       ${env('feeAccount')} registered under auditor 0`);
  log(`token             ${env('token')}`);
}

/** SHA-256 of the wasm a deployed contract runs: its wasm hash. */
async function wasmHashOf(
  server: rpc.Server,
  contractId: string,
): Promise<Buffer> {
  const wasm = await server.getContractWasmByContractId(contractId);
  return createHash('sha256').update(wasm).digest();
}

/** Deploys a new instance of `wasmHash` with constructor args; returns its id. */
async function deploy(
  server: rpc.Server,
  deployer: Keypair,
  wasmHash: Buffer,
  constructorArgs: xdr.ScVal[],
): Promise<string> {
  const result = await submit(
    server,
    deployer,
    Operation.createCustomContract({
      address: new Address(deployer.publicKey()),
      wasmHash,
      constructorArgs,
      salt: randomBytes(32),
    }),
  );
  if (!result.returnValue) {
    throw new Error('The deployment returned no contract address.');
  }
  return scValToNative(result.returnValue) as string;
}

/** Simulates, signs, submits and waits for one Soroban operation. */
async function submit(
  server: rpc.Server,
  signer: Keypair,
  operation: xdr.Operation,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const source = await server.getAccount(signer.publicKey());
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(180)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new Error(`Submission rejected: ${JSON.stringify(sent.errorResult)}`);
  }
  const final = await server.pollTransaction(sent.hash, { attempts: 60 });
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction ${sent.hash} ended ${final.status}`);
  }
  return final;
}

/** The token's `address_as_field_set` value, emitted by its constructor. */
async function readAddressAsField(
  server: rpc.Server,
  sdk: ConfidentialSdkModule,
  token: string,
  fromLedger: number,
): Promise<bigint | null> {
  // The RPC can index the ledger a moment after the transaction lands.
  for (let attempt = 0; attempt < 10; attempt++) {
    const resp = await server.getEvents({
      startLedger: fromLedger,
      filters: [{ type: 'contract', contractIds: [token] }],
      limit: 50,
    });
    for (const ev of resp.events) {
      if (scValToNative(ev.topic[0]) !== 'address_as_field_set') continue;
      const data = scValToNative(ev.value) as Record<string, unknown>;
      const value = data.address_as_field;
      if (value instanceof Uint8Array) return sdk.fromBytesBE(value);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

/** Sets each variable in a dotenv file, replacing a line that names it. */
function upsertEnv(path: string, values: Record<string, string>): void {
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original === '' ? [] : original.split(/\r?\n/);
  for (const [name, value] of Object.entries(values)) {
    const at = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (at >= 0) lines[at] = `${name}=${value}`;
    else {
      if (!lines.some((line) => line.startsWith('# ZK payments (testnet)'))) {
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        lines.push(
          '',
          '# ZK payments (testnet), written by scripts/zk/deploy-testnet.ts',
        );
      }
      lines.push(`${name}=${value}`);
    }
  }
  writeFileSync(path, `${lines.join(eol).replace(/(\r?\n)*$/, '')}${eol}`);
}

function writeSecrets(path: string, secrets: object): void {
  const full = resolve(path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  chmodSync(full, 0o600);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `\nZK testnet deploy failed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
