import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Horizon, Networks } from '@stellar/stellar-sdk';
import { AppConfig, StellarNetwork } from '@/config/configuration';
import { HORIZON_TIMEOUT_MS } from '@/stellar/stellar.constants';

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
