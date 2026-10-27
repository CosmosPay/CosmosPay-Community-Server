import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Networks, rpc, type Transaction } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';
import { SOROBAN_RPC_TIMEOUT_MS } from '@/stellar/stellar.constants';

/**
 * The one way this service reaches Stellar mainnet's Soroban RPC
 * (`STELLAR_RPC_URL_MAINNET`): simulate a contract call, submit a signed
 * transaction, look one up. Feature code never builds an `rpc.Server` itself.
 *
 * Like `SolanaRpcClient` and `EvmRpcClient`, it checks the node before trusting
 * it: the passphrase `getNetwork` reports must be mainnet's, or every call
 * answers `503 misconfigured` (an RPC on another network would simulate against
 * other contracts and broadcast where the signature means something else). The
 * check is cached once it passes, and retried after it fails.
 *
 * Every call runs under {@link SOROBAN_RPC_TIMEOUT_MS}, and a transport failure
 * is a `503 provider_unavailable` that says nothing about the node. What a
 * node ANSWERS (a simulation error, a rejected submission) is returned, not
 * thrown: only the caller knows what it means.
 */
@Injectable()
export class SorobanRpcClient {
  private readonly logger = new Logger(SorobanRpcClient.name);
  private server?: rpc.Server;
  private networkCheck?: Promise<void>;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /** Mainnet's passphrase: what every transaction this client handles is signed for. */
  get passphrase(): string {
    return Networks.PUBLIC;
  }

  simulate(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse> {
    return this.call('simulateTransaction', (server) =>
      server.simulateTransaction(tx),
    );
  }

  send(tx: Transaction): Promise<rpc.Api.SendTransactionResponse> {
    return this.call('sendTransaction', (server) => server.sendTransaction(tx));
  }

  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse> {
    return this.call('getTransaction', (server) => server.getTransaction(hash));
  }

  /** The wasm a deployed contract runs. */
  contractWasm(contractId: string): Promise<Uint8Array> {
    return this.call('getContractWasmByContractId', (server) =>
      server.getContractWasmByContractId(contractId),
    );
  }

  private async call<T>(
    what: string,
    run: (server: rpc.Server) => Promise<T>,
  ): Promise<T> {
    const server = this.rpcServer();
    await this.assertNetwork(server);
    return this.upstream(what, () => run(server));
  }

  private rpcServer(): rpc.Server {
    if (!this.server) {
      const url = this.config.get('stellar', { infer: true }).mainnetRpcUrl;
      this.server = new rpc.Server(url, {
        allowHttp: url.startsWith('http://'),
        timeout: SOROBAN_RPC_TIMEOUT_MS,
      });
    }
    return this.server;
  }

  /** Refuses a node that serves another network than mainnet. */
  private assertNetwork(server: rpc.Server): Promise<void> {
    if (!this.networkCheck) {
      const check = (async () => {
        const network = await this.upstream('getNetwork', () =>
          server.getNetwork(),
        );
        if (network.passphrase !== this.passphrase) {
          this.logger.error(
            `Soroban RPC ${server.serverURL.toString()} serves ` +
              `"${network.passphrase}", not Stellar mainnet`,
          );
          throw ApiError.unavailable(
            ApiErrorCode.Misconfigured,
            'The Soroban RPC configured for Stellar mainnet (STELLAR_RPC_URL_MAINNET) serves another network.',
          );
        }
      })();
      this.networkCheck = check;
      check.catch(() => {
        if (this.networkCheck === check) this.networkCheck = undefined;
      });
    }
    return this.networkCheck;
  }

  /**
   * Runs one call under {@link SOROBAN_RPC_TIMEOUT_MS}, turning a transport
   * failure into `503 provider_unavailable`. An `ApiError` passes through.
   */
  private async upstream<T>(what: string, run: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${SOROBAN_RPC_TIMEOUT_MS} ms`)),
        SOROBAN_RPC_TIMEOUT_MS,
      );
      timer.unref();
    });
    try {
      return await Promise.race([run(), timeout]);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      this.logger.warn(`Soroban RPC ${what} failed: ${String(err)}`);
      throw ApiError.unavailable(
        ApiErrorCode.ProviderUnavailable,
        'The Stellar mainnet Soroban RPC is unavailable. Retry shortly.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
