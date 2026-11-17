import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PaymentDeposit, SandboxPayout } from '@generated/prisma/client';
import type { AppConfig } from '@/config/configuration';
import { addressOfSecretKey, signEip1559 } from '@/evm/evm-transaction';
import { hexToBytes } from '@/evm/rlp';
import type { PaymentNetwork } from '@/payment-intents/payment-networks';
import {
  erc20TransferCalldata,
  SandboxEvmClient,
} from '@/sandbox-settlement/sandbox-evm.client';
import {
  depositPath,
  depositSecretKey,
  newDepositIndexes,
} from '@/sandbox-settlement/sandbox-hd';
import type {
  SandboxDepositTarget,
  SandboxLedger,
  SandboxTransfer,
  SandboxTxOutcome,
  SignedSandboxTransfer,
} from '@/sandbox-settlement/sandbox-ledger';
import { SANDBOX_TRANSFER_GAS_FALLBACK } from '@/sandbox-settlement/sandbox-settlement.constants';

/**
 * The sandbox on the EVM test networks: a BIP-32 deposit address per payment
 * (`m/44'/60'/7007'/a'/b'`), its ERC-20 balance as what arrived, and EIP-1559
 * ERC-20 transfers from the treasury (`SANDBOX_TREASURY_PRIVATE_KEY`, the same
 * address on every EVM test network).
 */
@Injectable()
export class SandboxEvmLedger implements SandboxLedger {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly chains: SandboxEvmClient,
  ) {}

  newDeposit(): SandboxDepositTarget {
    const indexes = newDepositIndexes();
    const seed = this.config.get('sandbox', { infer: true }).depositSeed;
    return {
      address: addressOfSecretKey(depositSecretKey(seed, indexes)),
      memo: null,
      locator: depositPath(indexes),
    };
  }

  treasuryAddress(): string {
    return addressOfSecretKey(this.treasuryKey());
  }

  received(deposit: PaymentDeposit): Promise<bigint> {
    return this.chains.erc20BalanceOf(
      deposit.originChain as PaymentNetwork,
      deposit.originContract ?? '',
      deposit.depositAddress,
    );
  }

  async blocker(transfer: SandboxTransfer): Promise<string | null> {
    const treasury = this.treasuryAddress();
    const balance = await this.chains.erc20BalanceOf(
      transfer.network,
      transfer.token,
      treasury,
    );
    return balance < transfer.amount
      ? `the treasury ${treasury} holds ${balance} of ${transfer.token}, below ${transfer.amount}: fund it`
      : null;
  }

  async sign(transfer: SandboxTransfer): Promise<SignedSandboxTransfer> {
    const { network, token, recipient, amount } = transfer;
    const key = this.treasuryKey();
    const treasury = addressOfSecretKey(key);
    const data = erc20TransferCalldata(recipient, amount);
    const [nonce, fees, estimate] = await Promise.all([
      this.chains.pendingNonce(network, treasury),
      this.chains.feeData(network),
      this.chains.estimateGas(network, { from: treasury, to: token, data }),
    ]);
    const signed = signEip1559(
      {
        chainId: this.chains.network(network).chainId,
        nonce,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        gasLimit: estimate
          ? (estimate * 13n) / 10n
          : SANDBOX_TRANSFER_GAS_FALLBACK,
        to: token,
        value: 0n,
        data,
      },
      key,
    );
    return { hash: signed.hash, raw: signed.raw, nonce: nonce.toString() };
  }

  broadcast(network: PaymentNetwork, raw: string): Promise<void> {
    return this.chains.sendRawTransaction(network, raw);
  }

  /** Mined: its receipt's status. Not mined: the same bytes again (same nonce and hash). */
  async follow(row: SandboxPayout): Promise<SandboxTxOutcome> {
    const network = row.network as PaymentNetwork;
    const receipt = await this.chains.receipt(network, row.txHash);
    if (!receipt) {
      await this.chains.sendRawTransaction(network, row.raw);
      return 'pending';
    }
    return receipt.succeeded ? 'succeeded' : 'failed';
  }

  explorerTx(network: PaymentNetwork, hash: string): string {
    return `${this.chains.network(network).explorerTx}${hash}`;
  }

  async treasuryReport(network: PaymentNetwork): Promise<string> {
    const entry = this.chains.network(network);
    const treasury = this.treasuryAddress();
    const gas = await this.chains.nativeBalance(network, treasury);
    const token =
      entry.stablecoin.contract ??
      this.config.get('sandbox', { infer: true }).cusdAddresses[network];
    const stable = token
      ? `${await this.chains.erc20BalanceOf(network, token, treasury)} base units`
      : 'not deployed';
    return `treasury ${treasury} gas ${gas} wei, ${entry.stablecoin.symbol} ${stable}`;
  }

  private treasuryKey(): Uint8Array {
    const hex = this.config.get('sandbox', { infer: true }).treasuryPrivateKey;
    if (!hex) throw new Error('SANDBOX_TREASURY_PRIVATE_KEY is not set');
    return hexToBytes(hex);
  }
}
