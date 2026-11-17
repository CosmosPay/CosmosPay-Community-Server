import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { PaymentDeposit, SandboxPayout } from '@generated/prisma/client';
import type { AppConfig } from '@/config/configuration';
import {
  depositPath,
  ed25519DepositSecret,
  newDepositIndexes,
  treasurySubkey,
} from '@/sandbox-settlement/sandbox-hd';
import type {
  SandboxDepositTarget,
  SandboxLedger,
  SandboxTransfer,
  SandboxTxOutcome,
  SignedSandboxTransfer,
} from '@/sandbox-settlement/sandbox-ledger';
import { SandboxNearClient } from '@/sandbox-settlement/sandbox-near.client';
import {
  type NearFunctionCall,
  nearAccountOfSecret,
  nearPublicKeyString,
  signNearTransaction,
} from '@/sandbox-settlement/sandbox-near.codec';
import {
  SANDBOX_NEAR_COIN_TYPE,
  SANDBOX_NEAR_GAS_RESERVE,
  SANDBOX_NEAR_ONE_YOCTO,
  SANDBOX_NEAR_STORAGE_BYTE_COST,
  SANDBOX_NEAR_STORAGE_DEPOSIT,
  SANDBOX_NEAR_STORAGE_GAS,
  SANDBOX_NEAR_TESTNET,
  SANDBOX_NEAR_TRANSFER_GAS,
} from '@/sandbox-settlement/sandbox-near.constants';

/** The token registration a NEP-141 holder needs before it can receive. */
function storageDeposit(account: string): NearFunctionCall {
  return {
    methodName: 'storage_deposit',
    args: { account_id: account, registration_only: true },
    gas: SANDBOX_NEAR_STORAGE_GAS,
    deposit: SANDBOX_NEAR_STORAGE_DEPOSIT,
  };
}

/**
 * The sandbox on NEAR's test network.
 *
 * - A deposit is paid to its own implicit account: the hex of an ed25519 key
 *   derived with SLIP-0010 at `m/44'/397'/7007'/a'/b'` from the sandbox seed.
 *   It exists as soon as anything arrives; to receive the test USDC it must be
 *   registered with the token, which the treasury does while the deposit
 *   waits (`prepareDeposit`).
 * - The treasury is the implicit account of HKDF(`SANDBOX_TREASURY_PRIVATE_KEY`,
 *   `treasury:near`). Every payout or refund is ONE transaction to the token
 *   with two calls, `storage_deposit` for the recipient (refunded in full when
 *   it is already registered) and `ft_transfer`, so a merchant that never held
 *   the token is paid all the same.
 * - A transaction is anchored to a final block and expires with it (about a
 *   day): one the node no longer knows and refuses as expired never ran and
 *   never will, which is the only `failed` besides a failed execution.
 */
@Injectable()
export class SandboxNearLedger implements SandboxLedger {
  private readonly logger = new Logger(SandboxNearLedger.name);
  /** The last nonce this process signed with: two sends in one tick never share one. */
  private lastNonce = 0n;

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly client: SandboxNearClient,
  ) {}

  newDeposit(): SandboxDepositTarget {
    const indexes = newDepositIndexes();
    const seed = this.config.get('sandbox', { infer: true }).depositSeed;
    return {
      address: nearAccountOfSecret(
        ed25519DepositSecret(seed, SANDBOX_NEAR_COIN_TYPE, indexes),
      ),
      memo: null,
      locator: depositPath(indexes, SANDBOX_NEAR_COIN_TYPE),
    };
  }

  treasuryAddress(): string {
    return nearAccountOfSecret(this.treasurySecret());
  }

  received(deposit: PaymentDeposit): Promise<bigint> {
    return this.client.ftBalanceOf(
      deposit.originContract ?? this.token(),
      deposit.depositAddress,
    );
  }

  /**
   * Registers the deposit account with the token, from the treasury, while
   * nothing has arrived: a transfer to an unregistered account fails in the
   * payer's wallet. Best effort, looked at again on the next tick.
   */
  async prepareDeposit(deposit: PaymentDeposit): Promise<void> {
    const token = deposit.originContract ?? this.token();
    try {
      const registered = await this.client.storageBalanceOf(
        token,
        deposit.depositAddress,
      );
      if (registered !== null) return;
      const short = await this.gasShortfall();
      if (short) {
        this.logger.warn(
          `Sandbox deposit ${deposit.id}: cannot register ${deposit.depositAddress} with the token: ${short}`,
        );
        return;
      }
      const signed = await this.signCalls(token, [
        storageDeposit(deposit.depositAddress),
      ]);
      await this.client.sendTransaction(signed.raw);
      this.logger.log(
        `Sandbox deposit ${deposit.id}: registered ${deposit.depositAddress} with the token (tx=${signed.hash})`,
      );
    } catch (err) {
      this.logger.warn(
        `Sandbox deposit ${deposit.id}: token registration failed, retried next tick: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async blocker(transfer: SandboxTransfer): Promise<string | null> {
    const short = await this.gasShortfall();
    if (short) return short;
    const treasury = this.treasuryAddress();
    const balance = await this.client.ftBalanceOf(transfer.token, treasury);
    return balance < transfer.amount
      ? `the treasury ${treasury} holds ${balance} of ${transfer.token}, below ${transfer.amount}: fund it`
      : null;
  }

  sign(transfer: SandboxTransfer): Promise<SignedSandboxTransfer> {
    return this.signCalls(transfer.token, [
      storageDeposit(transfer.recipient),
      {
        methodName: 'ft_transfer',
        args: {
          receiver_id: transfer.recipient,
          amount: transfer.amount.toString(),
        },
        gas: SANDBOX_NEAR_TRANSFER_GAS,
        deposit: SANDBOX_NEAR_ONE_YOCTO,
      },
    ]);
  }

  async broadcast(_network: string, raw: string): Promise<void> {
    // An expired answer cannot happen to a transaction just anchored to a
    // final block; `follow` reads it if it ever does.
    await this.client.sendTransaction(raw);
  }

  async follow(row: SandboxPayout): Promise<SandboxTxOutcome> {
    const known = await this.client.transaction(
      row.txHash,
      this.treasuryAddress(),
    );
    if (known.state === 'succeeded') return 'succeeded';
    if (known.state === 'failed') {
      this.logger.error(
        `Sandbox ${row.kind} ${row.txHash} failed on NEAR: ${known.reason}`,
      );
      return 'failed';
    }
    if (known.state === 'pending') return 'pending';
    // Unknown to the node: the same bytes again, never new ones.
    const sent = await this.client.sendTransaction(row.raw);
    return sent === 'expired' ? 'failed' : 'pending';
  }

  explorerTx(_network: string, hash: string): string {
    return `${SANDBOX_NEAR_TESTNET.explorerTx}${hash}`;
  }

  async prepareTreasury(): Promise<string[]> {
    const treasury = this.treasuryAddress();
    const token = this.token();
    const account = await this.client.account(treasury);
    if (!account) {
      return [
        `treasury ${treasury} does not exist yet: send it test NEAR, then run this again`,
      ];
    }
    if ((await this.client.storageBalanceOf(token, treasury)) !== null) {
      return [`treasury ${treasury} is registered with the test USDC`];
    }
    const short = await this.gasShortfall();
    if (short) return [`treasury ${treasury} cannot register yet: ${short}`];
    const signed = await this.signCalls(token, [storageDeposit(treasury)]);
    const sent = await this.client.sendTransaction(signed.raw);
    return [
      `treasury ${treasury} registered with the test USDC (tx=${signed.hash}, ${sent})`,
    ];
  }

  async treasuryReport(): Promise<string> {
    const treasury = this.treasuryAddress();
    const token = this.token();
    const account = await this.client.account(treasury);
    if (!account) return `treasury ${treasury} not created yet (no NEAR)`;
    const [usdc, registered] = await Promise.all([
      this.client.ftBalanceOf(token, treasury),
      this.client.storageBalanceOf(token, treasury),
    ]);
    return (
      `treasury ${treasury} NEAR ${account.amount} yocto, ` +
      `USDC ${usdc} base units, ${registered === null ? 'not ' : ''}registered with the token`
    );
  }

  /**
   * Why the treasury cannot pay for a transaction with a storage deposit
   * attached: no account yet, or less spendable NEAR than the deposit and a
   * gas reserve. Null when it can.
   */
  private async gasShortfall(): Promise<string | null> {
    const treasury = this.treasuryAddress();
    const account = await this.client.account(treasury);
    if (!account) {
      return `the treasury ${treasury} does not exist on ${SANDBOX_NEAR_TESTNET.testnetName} yet: send it test NEAR`;
    }
    const locked = account.storageUsage * SANDBOX_NEAR_STORAGE_BYTE_COST;
    const spendable = account.amount > locked ? account.amount - locked : 0n;
    const needed = SANDBOX_NEAR_STORAGE_DEPOSIT + SANDBOX_NEAR_GAS_RESERVE;
    return spendable < needed
      ? `the treasury ${treasury} can spend ${spendable} yoctoNEAR, below ${needed}: fund it`
      : null;
  }

  /** Signs one transaction from the treasury to `receiver` with `calls`. */
  private async signCalls(
    receiver: string,
    calls: NearFunctionCall[],
  ): Promise<SignedSandboxTransfer> {
    const secret = this.treasurySecret();
    const publicKey = ed25519.getPublicKey(secret);
    const signerId = this.treasuryAddress();
    const [current, blockHash] = await Promise.all([
      this.client.accessKeyNonce(signerId, nearPublicKeyString(publicKey)),
      this.client.finalBlockHash(),
    ]);
    if (current === null) {
      throw new Error(
        `The sandbox treasury ${signerId} has no access key on ${SANDBOX_NEAR_TESTNET.testnetName}: send it test NEAR`,
      );
    }
    const nonce =
      current + 1n > this.lastNonce + 1n ? current + 1n : this.lastNonce + 1n;
    const signed = signNearTransaction(
      {
        signerId,
        publicKey,
        nonce,
        receiverId: receiver,
        blockHash,
        actions: calls,
      },
      secret,
    );
    this.lastNonce = nonce;
    return { hash: signed.hash, raw: signed.raw, nonce: nonce.toString() };
  }

  private token(): string {
    const contract = SANDBOX_NEAR_TESTNET.stablecoin.contract;
    if (!contract) throw new Error('NEAR test USDC has no contract');
    return contract;
  }

  private treasurySecret(): Uint8Array {
    const hex = this.config.get('sandbox', { infer: true }).treasuryPrivateKey;
    if (!hex) throw new Error('SANDBOX_TREASURY_PRIVATE_KEY is not set');
    return treasurySubkey(hex, 'near');
  }
}
