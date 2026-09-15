import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Memo, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { AppConfig, StellarNetwork } from '@/config/configuration';
import { StellarAccountLoader } from '@/stellar/account-loader.service';
import { ResolvedAsset } from '@/stellar/asset';
import { sep7PayUri, sep7Qr, sep7TxUri } from '@/stellar/sep7';
import { StellarService } from '@/stellar/stellar.service';

/** The terms both SEP-7 operations encode. */
interface Sep7Payment {
  destination: string;
  asset: ResolvedAsset;
  /** A MEMO_ID, already validated or minted. */
  memo: string;
  msg?: string;
  callback?: string;
}

export interface Sep7TxPayment extends Sep7Payment {
  source: string;
  amount: string;
}

export interface Sep7PayPayment extends Sep7Payment {
  /** Absent for an open-amount intent: the payer chooses. */
  amount?: string;
}

/**
 * Encodes a payment intent as the SEP-7 request a wallet opens: the
 * `web+stellar:tx` / `web+stellar:pay` URI, the unsigned envelope a `tx` link
 * carries, and the QR code of either.
 *
 * Split out of `PaymentIntentsService`, which otherwise spoke two vocabularies:
 * an intent's lifecycle (idempotency, transitions, audit, webhooks) and the wire
 * format of its link (URI parameter names, operations, fee, timebounds). They
 * change for different reasons — a SEP-7 or SDK change belongs here and never
 * touches a lifecycle rule.
 *
 * It builds and never decides: idempotency is settled before anything here is
 * called, which is what keeps a replayed create from costing a Horizon call.
 *
 * The URI and QR encoding itself is `@/stellar/sep7`, shared with swaps and
 * liquidity pools; what is this class's own is the intent's envelope.
 */
@Injectable()
export class Sep7LinkBuilder {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly stellar: StellarService,
    private readonly accounts: StellarAccountLoader,
  ) {}

  /**
   * SEP-7 `tx`: the unsigned envelope for one payment from a known source, and
   * the URI carrying it.
   *
   * The only method here that touches the network — the source is loaded for
   * its sequence number — so the only one that can fail on it, with the
   * loader's errors (400 for an unfunded source, 503 when Horizon is out).
   */
  async tx(
    network: StellarNetwork,
    payment: Sep7TxPayment,
  ): Promise<{ xdr: string; uri: string }> {
    const { baseFee, timeoutSeconds } = this.config.get('stellar', {
      infer: true,
    });
    const account = await this.accounts.load(network, payment.source);
    const xdr = new TransactionBuilder(account, {
      fee: baseFee,
      networkPassphrase: this.stellar.passphrase(network),
    })
      .addOperation(
        Operation.payment({
          destination: payment.destination,
          amount: payment.amount,
          asset: payment.asset.asset,
        }),
      )
      .addMemo(Memo.id(payment.memo))
      .setTimeout(timeoutSeconds)
      .build()
      .toXDR();

    return { xdr, uri: sep7TxUri(xdr, payment) };
  }

  /**
   * SEP-7 `pay`: no source and no envelope. The wallet builds the transaction,
   * so the URI has to carry every term the payment must match — `memo_type`
   * included, because SEP-7 defaults a memo to text and the verifier only
   * accepts the intent's MEMO_ID.
   */
  pay(payment: Sep7PayPayment): string {
    return sep7PayUri(payment);
  }

  /** The QR a wallet scans for `uri`, as a PNG data URL. Derived, never stored. */
  qr(uri: string): Promise<string> {
    return sep7Qr(uri);
  }
}
