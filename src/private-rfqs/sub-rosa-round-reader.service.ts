import { Injectable } from '@nestjs/common';
import type {
  SealedProposal,
  SubmissionStateV2,
  SubRosaClient,
  SubRosaNetwork,
} from '@sub-rosa/sdk';

export type PrivateRfqNetwork = 'public' | 'testnet';

export interface RevealedPrivateQuote {
  provider: string;
  revealed: boolean;
  valid: boolean;
  amount: string | null;
  proposal: SealedProposal | null;
}

export interface SubRosaRoundSnapshot {
  contractId: string;
  roundId: string;
  itemRefHex: string;
  schemaRefHex: string;
  sealedProposalSchema: boolean;
  mode: string;
  clearingRule: string;
  roundStatus: string;
  commitDeadline: bigint;
  revealDeadline: bigint;
  revealComplete: boolean;
  quotes: RevealedPrivateQuote[];
}

export class SubRosaRoundReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SubRosaRoundReadError';
  }
}

function sdkNetwork(network: PrivateRfqNetwork): SubRosaNetwork {
  return network === 'public' ? 'mainnet' : 'testnet';
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

type SubRosaSdk = typeof import('@sub-rosa/sdk');

/**
 * Decode one revealed application payload without letting a malformed provider
 * submission make every other quote in the RFQ unavailable. The contract's
 * `valid` flag proves the canonical envelope/commitment; the partner schema is
 * an application-level check and therefore still has to fail closed here.
 */
export function decodeRevealedPrivateQuote(
  sdk: Pick<SubRosaSdk, 'decodePayloadEnvelope' | 'decodeSealedProposal'>,
  provider: string,
  state: SubmissionStateV2,
): RevealedPrivateQuote {
  if (!state.revealed_envelope) {
    return {
      provider,
      revealed: false,
      valid: state.valid,
      amount: null,
      proposal: null,
    };
  }

  if (!state.valid) {
    return {
      provider,
      revealed: true,
      valid: false,
      amount: null,
      proposal: null,
    };
  }

  try {
    const envelope = sdk.decodePayloadEnvelope(
      new Uint8Array(state.revealed_envelope),
    );
    return {
      provider,
      revealed: true,
      valid: true,
      amount: envelope.amount?.toString() ?? null,
      proposal: sdk.decodeSealedProposal(envelope.payload),
    };
  } catch {
    return {
      provider,
      revealed: true,
      valid: false,
      amount: null,
      proposal: null,
    };
  }
}

// TypeScript rewrites import() to require() under this repository's CommonJS
// build. The SDK intentionally exports ESM only, so keep the native import for
// Node 24 instead of making Cosmos Pay hold a fork of the package.
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- intentional native ESM bridge
const nativeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<SubRosaSdk>;

/** Read-only adapter around the published SDK. It never configures a signer. */
@Injectable()
export class SubRosaRoundReader {
  private readonly clients = new Map<SubRosaNetwork, SubRosaClient>();
  private sdkPromise?: Promise<SubRosaSdk>;

  async read(
    network: PrivateRfqNetwork,
    contractId: string,
    roundId: string,
  ): Promise<SubRosaRoundSnapshot> {
    const sdk = await this.sdk();
    const expectedContract = sdk.resolveSubRosaDeployment(
      sdkNetwork(network),
    ).contractId;
    if (contractId !== expectedContract) {
      throw new SubRosaRoundReadError(
        `contractId is not the canonical Sub Rosa ${network} deployment`,
      );
    }

    try {
      const client = this.client(sdk, sdkNetwork(network));
      const rid = BigInt(roundId);
      const [round, bidders] = await Promise.all([
        client.getRoundV2(rid),
        client.getBiddersV2(rid),
      ]);
      const states = await Promise.all(
        bidders.map(async (provider) => ({
          provider,
          state: await client.getSubmissionV2(rid, provider),
        })),
      );

      const decoded = states.map(({ provider, state }) =>
        decodeRevealedPrivateQuote(sdk, provider, state),
      );
      const terminalReveal =
        round.status.tag === 'Cleared' || round.status.tag === 'Settled';
      const revealComplete =
        bidders.length > 0 &&
        (terminalReveal || decoded.every((quote) => quote.revealed));

      return {
        contractId,
        roundId,
        itemRefHex: hex(round.item_ref),
        schemaRefHex: hex(round.schema_ref),
        sealedProposalSchema:
          hex(round.schema_ref) === hex(sdk.SEALED_PROPOSAL_SCHEMA_REF),
        mode: round.mode.tag,
        clearingRule: round.clearing_rule.tag,
        roundStatus: round.status.tag,
        commitDeadline: round.commit_deadline,
        revealDeadline: round.reveal_deadline,
        revealComplete,
        quotes: decoded.map((quote) =>
          revealComplete ? quote : { ...quote, amount: null, proposal: null },
        ),
      };
    } catch (error) {
      if (error instanceof SubRosaRoundReadError) throw error;
      throw new SubRosaRoundReadError(
        `Sub Rosa round ${roundId} could not be read`,
        { cause: error },
      );
    }
  }

  private client(sdk: SubRosaSdk, network: SubRosaNetwork): SubRosaClient {
    const existing = this.clients.get(network);
    if (existing) return existing;
    // No secretKey, publicKey, or wallet callbacks: SDK get_* simulations only.
    const created = new sdk.SubRosaClient({ network });
    this.clients.set(network, created);
    return created;
  }

  private sdk(): Promise<SubRosaSdk> {
    this.sdkPromise ??= nativeImport('@sub-rosa/sdk');
    return this.sdkPromise;
  }
}
