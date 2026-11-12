import { Injectable } from '@nestjs/common';
import type { StellarNetwork } from '@/config/configuration';

/**
 * Payment requests (charges in local money shown as a QR) are owned by one
 * native plugin, and may be paid through rails other plugins serve. Plugins
 * never import each other, so this is the extension point both sides meet at:
 * the owner registers a {@link PaymentRequestLedger} (read a request, move it
 * to `processing` or `paid`), and every other rail registers a
 * {@link PaymentRequestRail} the owner consults when it creates and reads a
 * request. The core knows neither plugin.
 */

/**
 * Every way a payment request can be paid, in the order a payer is offered
 * them: a bank transfer first (the payer stays on the page), then the P2P
 * marketplace's hosted window.
 */
export const PAYMENT_REQUEST_METHODS = ['transfer', 'p2p'] as const;
export type PaymentRequestMethod = (typeof PAYMENT_REQUEST_METHODS)[number];

/** The rails another plugin serves: everything but the owner's own `p2p`. */
export type PaymentRequestRailMethod = Exclude<PaymentRequestMethod, 'p2p'>;

/** What a rail decides on: a request's terms, before or after it exists. */
export interface PaymentRequestTerms {
  /**
   * The local id of the consumer that owns (or is creating) the request: a rail
   * may pay only the requests of owners it has an account for. Never published.
   */
  ownerId: string;
  /** `public` or `testnet`, from the key that created it. */
  network: StellarNetwork;
  /** The local currency's id, exactly as given (`ARS`). */
  currency: string;
  /** Local money, a decimal string. */
  amount: string;
  /** EIP-155 id of the chain the token is delivered on. */
  chainId: number;
  /** The token's contract on `chainId`, any case. */
  tokenAddress: string;
}

/** A token as a request stores it: its symbol and its contract's decimals. */
export interface PaymentRequestToken {
  symbol: string;
  decimals: number;
}

/** A rail another plugin serves, registered into {@link PaymentRequestRails}. */
export interface PaymentRequestRail {
  readonly method: PaymentRequestRailMethod;
  /**
   * The token this rail would deliver for `terms` right now, or null when it
   * cannot pay them (not configured for the network, another currency, an
   * amount out of its bounds, a pair it does not serve). `listed` is the token
   * as the P2P market lists the pair on the request's network, null when it
   * does not: a rail that only simulates on a sandbox may accept exactly the
   * pairs the market lists there. Consulted on every read of a request, so
   * it must be cheap (its own config, a cached row) and must not call out.
   */
  accepts(
    terms: PaymentRequestTerms,
    listed: PaymentRequestToken | null,
  ): Promise<PaymentRequestToken | null>;
}

/** What a rail reads of a payment request. Never published as is. */
export interface PaymentRequestRecord {
  id: string;
  /** The local id of the consumer that owns it. Never published. */
  ownerId: string;
  network: StellarNetwork;
  /** What it reads as now: `open`, `processing`, `paid`, `expired` or `cancelled`. */
  status: string;
  currency: string;
  amount: string;
  chainId: number;
  token: string;
  tokenAddress: string;
  tokenDecimals: number;
  /** Where the token is delivered (EIP-55): the seller's own wallet. */
  address: string;
  expiresAt: Date;
  paidAt: Date | null;
}

/** How a request was paid, as the rail that paid it reports it. */
export interface PaymentRequestSettlement {
  method: PaymentRequestMethod;
  /** The token delivered, a decimal string; null when the rail reported none. */
  amount: string | null;
  /** The delivering transaction; null when the rail reported none. */
  txHash: string | null;
  at: Date;
}

/** The plugin that owns payment requests, registered into {@link PaymentRequestRails}. */
export interface PaymentRequestLedger {
  /** One request by its id, or null. No consumer: the caller decides what it may see. */
  find(id: string): Promise<PaymentRequestRecord | null>;
  /**
   * Marks the request `processing` (money received, the token on its way),
   * unless it was paid already: true when this call moved it. Conditional, so
   * a delivery applied twice changes nothing the second time.
   */
  markProcessing(id: string, at: Date): Promise<boolean>;
  /** Marks the request `paid`, unless a completion already did (the first wins): true when this call paid it. */
  markPaid(id: string, settlement: PaymentRequestSettlement): Promise<boolean>;
}

/**
 * The rails and the ledger the enabled plugins registered. Plugins register
 * from `onModuleInit`; reads happen while serving a request, by which point
 * every module has initialized.
 */
@Injectable()
export class PaymentRequestRails {
  private readonly rails = new Map<
    PaymentRequestRailMethod,
    PaymentRequestRail
  >();
  private ledgerOf: PaymentRequestLedger | null = null;

  registerRail(rail: PaymentRequestRail): void {
    if (this.rails.has(rail.method)) {
      throw new Error(
        `Payment request rail "${rail.method}" is registered twice: two plugins cannot serve the same method.`,
      );
    }
    this.rails.set(rail.method, rail);
  }

  registerLedger(ledger: PaymentRequestLedger): void {
    if (this.ledgerOf) {
      throw new Error(
        'A payment request ledger is registered twice: one plugin owns payment requests.',
      );
    }
    this.ledgerOf = ledger;
  }

  /**
   * The rails other plugins serve that accept `terms`, each with the token it
   * would deliver, in {@link PAYMENT_REQUEST_METHODS} order.
   */
  async accepting(
    terms: PaymentRequestTerms,
    listed: PaymentRequestToken | null,
  ): Promise<
    { method: PaymentRequestRailMethod; token: PaymentRequestToken }[]
  > {
    const found: {
      method: PaymentRequestRailMethod;
      token: PaymentRequestToken;
    }[] = [];
    for (const method of PAYMENT_REQUEST_METHODS) {
      if (method === 'p2p') continue;
      const rail = this.rails.get(method);
      const token = rail ? await rail.accepts(terms, listed) : null;
      if (token) found.push({ method, token });
    }
    return found;
  }

  /** Whether any other plugin registered a rail (a read can skip asking for the owner otherwise). */
  hasRails(): boolean {
    return this.rails.size > 0;
  }

  /**
   * Every method that can pay `terms` now, in {@link PAYMENT_REQUEST_METHODS}
   * order: the other plugins' rails that accept them, and `p2p` when the
   * owner's own check (`p2p`) says the marketplace takes them.
   */
  async methodsFor(
    terms: PaymentRequestTerms,
    listed: PaymentRequestToken | null,
    p2p: boolean,
  ): Promise<PaymentRequestMethod[]> {
    const rails = new Set<PaymentRequestMethod>(
      (await this.accepting(terms, listed)).map((rail) => rail.method),
    );
    if (p2p) rails.add('p2p');
    return PAYMENT_REQUEST_METHODS.filter((method) => rails.has(method));
  }

  /** The owner of payment requests; throws when no enabled plugin registered one. */
  ledger(): PaymentRequestLedger {
    if (!this.ledgerOf) {
      throw new Error(
        'No payment request ledger is registered: the plugin that owns payment requests is not enabled.',
      );
    }
    return this.ledgerOf;
  }
}
