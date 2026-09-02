import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Horizon, Networks } from '@stellar/stellar-sdk';
import { AppConfig, StellarNetwork } from '../config/configuration';

/**
 * The SDK ships with `timeout: 0` — no timeout at all — on every Horizon read.
 * A stalled socket therefore hangs the caller forever, which matters most in the
 * background reconcilers: they guard each tick with a `running` latch that is
 * only cleared in a `finally`, so one hung request silently stops settlement on
 * that instance for good. Bound every Horizon call instead.
 *
 * This has to be set on each `Horizon.Server`'s own HTTP client. The obvious
 * `Config.setTimeout()` looks global but is not: in this SDK version only
 * `federation/server` and `stellartoml` ever call `Config.getTimeout()`, and
 * `horizon_axios_client.createHttpClient()` builds its client with headers and
 * no timeout at all — so the global setter left every Horizon read unbounded
 * while reading as if it had fixed exactly this. `server.httpClient` is a
 * documented, mutable escape hatch in the SDK's own JSDoc.
 *
 * `submitTransaction` passes its own longer per-request timeout, which takes
 * precedence over this default, so transaction submission is unaffected.
 */
const HORIZON_TIMEOUT_MS = 15_000;

/**
 * Resolves Stellar primitives per network. Because a payment intent's network is
 * derived from the caller's API key type (dev → testnet, prod → public), every
 * Horizon interaction must target the right network — this service hands out the
 * correct (cached) Horizon server and network passphrase for a given network.
 */
@Injectable()
export class StellarService {
  private readonly servers = new Map<StellarNetwork, Horizon.Server>();

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  passphrase(network: StellarNetwork): string {
    return network === 'public' ? Networks.PUBLIC : Networks.TESTNET;
  }

  server(network: StellarNetwork): Horizon.Server {
    let server = this.servers.get(network);
    if (!server) {
      const url = this.config.get('stellar', { infer: true }).horizon[network];
      server = new Horizon.Server(url);
      // Bound every read this server issues; see HORIZON_TIMEOUT_MS.
      server.httpClient.defaults.timeout = HORIZON_TIMEOUT_MS;
      this.servers.set(network, server);
    }
    return server;
  }
}
