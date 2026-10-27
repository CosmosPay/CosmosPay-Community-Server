import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type Horizon,
  Memo,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
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
  /** What `destination` receives (the merchant's leg). */
  amount: string;
  /** A merchant fee: a second payment, in the same asset, to its wallet. */
  fee?: { wallet: string; amount: string } | null;
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
   * The only method here that touches the network (the source is loaded for
   * its sequence number, and the destination of an issued asset for its
   * trustlines), so the only one that can fail on it: with the loader's errors
   * (400 for an unfunded account, 503 when Horizon is out), or
   * `trustline_missing` from {@link assertDestinationCanReceive}.
   */
  async tx(
    network: StellarNetwork,
    payment: Sep7TxPayment,
  ): Promise<{ xdr: string; uri: string }> {
    const { baseFee, timeoutSeconds } = this.config.get('stellar', {
      infer: true,
    });
    const account = await this.accounts.load(network, payment.source);
    await this.assertDestinationCanReceive(network, payment, account);
    const builder = new TransactionBuilder(account, {
      fee: baseFee,
      networkPassphrase: this.stellar.passphrase(network),
    }).addOperation(
      Operation.payment({
        destination: payment.destination,
        amount: payment.amount,
        asset: payment.asset.asset,
      }),
    );
    // The merchant fee: its own payment, after the merchant's, so the two legs
    // stay apart on-chain and the verifier can hold the intent to both.
    if (payment.fee) {
      builder.addOperation(
        Operation.payment({
          destination: payment.fee.wallet,
          amount: payment.fee.amount,
          asset: payment.asset.asset,
        }),
      );
    }
    const xdr = builder
      .addMemo(Memo.id(payment.memo))
      .setTimeout(timeoutSeconds)
      .build()
      .toXDR();

    return { xdr, uri: sep7TxUri(xdr, payment) };
  }

  /**
   * The merchant's `destination` must already trust an issued asset, or the
   * payment fails on-chain with `op_no_trust` after the payer has signed it and
   * paid the fee. The payer signs this envelope and the merchant signs nothing,
   * so the trustline cannot go into it: only the merchant's own account can add
   * it, and the refusal says so. Lumens need no trustline and skip the read.
   */
  private async assertDestinationCanReceive(
    network: StellarNetwork,
    payment: Sep7TxPayment,
    source: Horizon.AccountResponse,
  ): Promise<void> {
    const { asset, destination } = payment;
    if (asset.code === 'native' || !asset.issuer) return;
    const receiver =
      destination === payment.source
        ? source
        : await this.accounts.load(network, destination);
    this.accounts.assertCanReceive(
      receiver.balances,
      asset,
      destination,
      'this payment',
    );
  }

  /**
   * A merchant fee's wallet must exist and, for an issued asset, trust it, or
   * the fee payment fails on-chain and takes the merchant's with it. Checked
   * when the intent is created, before any payer is asked to sign.
   */
  async assertWalletCanReceive(
    network: StellarNetwork,
    asset: ResolvedAsset,
    wallet: string,
  ): Promise<void> {
    const receiver = await this.accounts.load(network, wallet);
    this.accounts.assertCanReceive(
      receiver.balances,
      asset,
      wallet,
      'the merchant fee',
    );
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
