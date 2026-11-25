import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig, StellarNetwork } from '@/config/configuration';
import { KoyweVirtualAccounts } from '@/native-plugins/koywe/koywe-virtual-accounts.service';
import {
  KOYWE_DEPOSIT_ACCOUNT_TTL_MS,
  KOYWE_PROVIDER,
} from '@/native-plugins/koywe/koywe.constants';

/** Where a payer transfers to, as the instructions say it. */
export interface DepositInstructions {
  alias: string;
  cvu: string;
  holder: string | null;
  bank: string | null;
}

/**
 * Cosmos Pay's own merchant's deposit account (pooled mode): its alias and
 * CVU from the provider's ARS virtual account, read at most every ten minutes
 * per network and created once if missing, with `KOYWE_ALIAS` / `KOYWE_CVU`
 * replacing what it reports and `KOYWE_ACCOUNT_HOLDER` as the holder. Null
 * when the alias or the CVU cannot be had: the caller answers 503.
 */
@Injectable()
export class KoywePooledAccount {
  private readonly logger = new Logger(KoywePooledAccount.name);
  private readonly cached = new Map<
    StellarNetwork,
    { at: number; instructions: DepositInstructions }
  >();

  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly accounts: KoyweVirtualAccounts,
  ) {}

  async instructions(
    network: StellarNetwork,
    merchantId: string,
  ): Promise<DepositInstructions | null> {
    const koywe = this.config.get('koywe', { infer: true });
    const holder = koywe.accountHolder || null;
    if (koywe.alias && koywe.cvu) {
      return { alias: koywe.alias, cvu: koywe.cvu, holder, bank: null };
    }
    const hit = this.cached.get(network);
    if (hit && Date.now() - hit.at < KOYWE_DEPOSIT_ACCOUNT_TTL_MS) {
      return hit.instructions;
    }
    const account = await this.accounts.ars(network, merchantId);
    const alias = koywe.alias || account.alias;
    const cvu = koywe.cvu || account.cvu;
    if (!alias || !cvu) {
      this.logger.error(
        `${KOYWE_PROVIDER} (${network}) pooled ARS account has no ${alias ? 'CVU' : 'alias'}: ` +
          'set one on the virtual account, or KOYWE_ALIAS / KOYWE_CVU',
      );
      return null;
    }
    const instructions = { alias, cvu, holder, bank: account.bank };
    this.cached.set(network, { at: Date.now(), instructions });
    return instructions;
  }
}
