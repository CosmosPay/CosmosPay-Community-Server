/**
 * An EVM inside the jest process, for testing this repo's contracts by running
 * them rather than by reading their bytecode. Test-only: the `*spec.ts` suffix
 * keeps it out of `nest build`, and the name keeps jest from running it as a
 * suite. It compiles with the repo's own `solc` and drives calls with viem's
 * ABI codec, so a test reads like the contract's interface.
 *
 * Every call runs as its own committed transaction at the harness' clock
 * (`now`, advanced with `warp`). Callers are bare addresses: no keys, no
 * nonces, no gas money (`skipBalance`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEVM, type EVM } from '@ethereumjs/evm';
import { createAddressFromString } from '@ethereumjs/util';
import {
  bytesToHex,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  hexToBytes,
  keccak256,
  toHex,
  type Abi,
  type Hex,
} from 'viem';

// solc-js ships no types; its surface here is one function.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const solc = require('solc') as { compile(input: string): string };

const ROOT = join(__dirname, '..', '..');

export interface CompiledContract {
  abi: Abi;
  bytecode: Hex;
}

/** Compiles one contract file under `contracts/` with the given settings. */
export function compileContract(
  relativePath: string,
  name: string,
  evmVersion = 'paris',
): CompiledContract {
  const source = readFileSync(join(ROOT, 'contracts', relativePath), 'utf8');
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources: { [relativePath]: { content: source } },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion,
          metadata: { bytecodeHash: 'none' },
          outputSelection: { '*': { [name]: ['abi', 'evm.bytecode.object'] } },
        },
      }),
    ),
  ) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<
      string,
      Record<string, { abi: Abi; evm: { bytecode: { object: string } } }>
    >;
  };
  const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  }
  const contract = output.contracts[relativePath][name];
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
}

/** A deterministic test address from a label. */
export function addressOf(label: string): Hex {
  return getAddress(keccak256(toHex(label)).slice(0, 42));
}

/** A log as the EVM emitted it, undecoded. */
export interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
}

export interface DecodedLog {
  address: Hex;
  eventName: string;
  args: Record<string, unknown>;
}

export interface CallResult {
  ok: boolean;
  /** The decoded return value of a successful call. */
  result: unknown;
  /** The custom error's name (or `Error(string)`'s reason) of a reverted call. */
  error?: string;
  errorArgs?: readonly unknown[];
  logs: DecodedLog[];
}

export class DeployedContract {
  constructor(
    readonly evm: InProcessEvm,
    readonly address: Hex,
    readonly abi: Abi,
  ) {}

  /** Sends a call from `from`; returns its outcome without throwing on a revert. */
  async send(
    from: Hex,
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<CallResult> {
    return this.evm.call(from, this, functionName, args);
  }

  /** Sends a call and throws unless it succeeded. */
  async must(
    from: Hex,
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<CallResult> {
    const result = await this.send(from, functionName, args);
    if (!result.ok) {
      throw new Error(
        `${functionName} reverted with ${result.error ?? 'no reason'}`,
      );
    }
    return result;
  }

  /** A read: the decoded return value. */
  async read<T = unknown>(
    functionName: string,
    args: readonly unknown[] = [],
  ): Promise<T> {
    const result = await this.evm.call(
      addressOf('reader'),
      this,
      functionName,
      args,
    );
    if (!result.ok) throw new Error(`${functionName} reverted`);
    return result.result as T;
  }
}

export class InProcessEvm {
  /** Block timestamp, in seconds, of the next call. */
  now = 1_800_000_000n;
  private block = 1n;
  /** Every ABI deployed here, to decode logs any contract emits. */
  private readonly abis = new Map<string, Abi>();

  private constructor(private readonly evm: EVM) {}

  static async create(): Promise<InProcessEvm> {
    return new InProcessEvm(await createEVM());
  }

  warp(seconds: number | bigint): void {
    this.now += BigInt(seconds);
  }

  async deploy(
    from: Hex,
    contract: CompiledContract,
    args: readonly unknown[] = [],
  ): Promise<DeployedContract> {
    const data = encodeDeployData({
      abi: contract.abi,
      bytecode: contract.bytecode,
      args,
    });
    const res = await this.evm.runCall({
      caller: createAddressFromString(from),
      data: hexToBytes(data),
      gasLimit: 30_000_000n,
      skipBalance: true,
      block: this.nextBlock(),
    });
    if (res.execResult.exceptionError || !res.createdAddress) {
      const reason = this.decodeError(
        contract.abi,
        bytesToHex(res.execResult.returnValue),
      );
      throw new Error(`deploy reverted: ${reason.error ?? 'no reason'}`);
    }
    const address = getAddress(res.createdAddress.toString());
    this.abis.set(address.toLowerCase(), contract.abi);
    return new DeployedContract(this, address, contract.abi);
  }

  async call(
    from: Hex,
    contract: DeployedContract,
    functionName: string,
    args: readonly unknown[],
  ): Promise<CallResult> {
    const data = encodeFunctionData({
      abi: contract.abi,
      functionName,
      args,
    });
    const res = await this.evm.runCall({
      caller: createAddressFromString(from),
      to: createAddressFromString(contract.address),
      data: hexToBytes(data),
      gasLimit: 30_000_000n,
      skipBalance: true,
      block: this.nextBlock(),
    });
    const returned = bytesToHex(res.execResult.returnValue);
    if (res.execResult.exceptionError) {
      return {
        ok: false,
        result: undefined,
        logs: [],
        ...this.decodeError(contract.abi, returned),
      };
    }
    const result =
      returned === '0x'
        ? undefined
        : decodeFunctionResult({
            abi: contract.abi,
            functionName,
            data: returned,
          });
    return { ok: true, result, logs: this.decodeLogs(res.execResult.logs) };
  }

  /**
   * Runs calldata this suite did NOT encode with viem (a codec under test) and
   * answers what came back raw: the return data and every log's topics and
   * data, for the codec's own decoder to read.
   */
  async callRaw(
    from: Hex,
    to: Hex,
    data: Hex,
  ): Promise<{ ok: boolean; returned: Hex; logs: RawLog[] }> {
    const res = await this.evm.runCall({
      caller: createAddressFromString(from),
      to: createAddressFromString(to),
      data: hexToBytes(data),
      gasLimit: 30_000_000n,
      skipBalance: true,
      block: this.nextBlock(),
    });
    return {
      ok: !res.execResult.exceptionError,
      returned: bytesToHex(res.execResult.returnValue),
      logs: (res.execResult.logs ?? []).map(([address, topics, logData]) => ({
        address: getAddress(bytesToHex(address)),
        topics: topics.map((t) => bytesToHex(t)),
        data: bytesToHex(logData),
      })),
    };
  }

  private decodeError(
    abi: Abi,
    data: Hex,
  ): { error?: string; errorArgs?: readonly unknown[] } {
    if (data === '0x') return {};
    for (const candidate of [abi, ...this.abis.values()]) {
      try {
        const decoded = decodeErrorResult({ abi: candidate, data });
        if (decoded.errorName === 'Error') {
          return { error: String(decoded.args?.[0]) };
        }
        return { error: decoded.errorName, errorArgs: decoded.args };
      } catch {
        // try the next ABI
      }
    }
    return { error: data };
  }

  private decodeLogs(
    logs: [Uint8Array, Uint8Array[], Uint8Array][] | undefined,
  ): DecodedLog[] {
    return (logs ?? []).flatMap(([address, topics, data]) => {
      const emitter = getAddress(bytesToHex(address));
      const abi = this.abis.get(emitter.toLowerCase());
      if (!abi) return [];
      try {
        const decoded = decodeEventLog({
          abi,
          topics: topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
          data: bytesToHex(data),
        });
        return [
          {
            address: emitter,
            eventName: decoded.eventName ?? '',
            args: (decoded.args ?? {}) as Record<string, unknown>,
          },
        ];
      } catch {
        return [];
      }
    });
  }

  private nextBlock() {
    const number = this.block++;
    const timestamp = this.now;
    return {
      header: {
        number,
        coinbase: createAddressFromString(addressOf('coinbase')),
        timestamp,
        difficulty: 0n,
        prevRandao: new Uint8Array(32),
        gasLimit: 30_000_000n,
        baseFeePerGas: 0n,
        getBlobGasPrice: () => undefined,
      },
    };
  }
}
