/**
 * LayerZero Scan's view of a message, and what it means for a transfer. Pure:
 * the HTTP call is `LayerZeroScanClient`'s.
 *
 * The shape is the one `GET https://scan.layerzero-api.com/v1/messages/tx/{hash}`
 * and `/messages/guid/{guid}` answered on 2026-10-25 for a USDT0 message from
 * Stellar (srcEid 30600) to Ethereum, cut to the fields read here.
 */

/** The overall statuses Scan's OpenAPI document lists for a message. */
export const LAYERZERO_SCAN_STATUSES = [
  'INFLIGHT',
  'CONFIRMING',
  'FAILED',
  'DELIVERED',
  'BLOCKED',
  'PAYLOAD_STORED',
  'APPLICATION_BURNED',
  'APPLICATION_SKIPPED',
  'UNRESOLVABLE_COMMAND',
  'MALFORMED_COMMAND',
] as const;
export type LayerZeroScanStatus = (typeof LAYERZERO_SCAN_STATUSES)[number];

/** One message, as far as this service reads it. */
export interface LayerZeroScanMessage {
  pathway?: { srcEid?: number; dstEid?: number };
  source?: { status?: string; tx?: { txHash?: string } };
  destination?: { status?: string; tx?: { txHash?: string } };
  guid?: string;
  status?: { name?: string; message?: string };
}

/** Scan's answer to a message lookup. */
export interface LayerZeroScanResponse {
  data?: LayerZeroScanMessage[];
}

/** What one message means for the transfer it carries. */
export type ScanOutcome =
  | { kind: 'travelling'; scanStatus: string; guid: string | null }
  | {
      kind: 'delivered';
      scanStatus: string;
      guid: string | null;
      destinationTxHash: string | null;
    }
  | { kind: 'failed'; scanStatus: string; guid: string | null; reason: string };

/**
 * Where each status leaves a transfer. A table, so a status Scan adds is a
 * decision made here and not a guess in a branch.
 *
 * - `INFLIGHT`, `CONFIRMING`: on its way (DVNs verifying, executor pending).
 * - `DELIVERED`: credited on the destination network.
 * - `BLOCKED` (an earlier message on the pathway is stuck) and `PAYLOAD_STORED`
 *   (the destination call reverted and the payload waits to be retried): not
 *   final, and anyone can clear them on the destination network, so the
 *   transfer stays SUBMITTED and `scanStatus` says why it is slow.
 * - `FAILED`, `APPLICATION_BURNED`, `APPLICATION_SKIPPED`: LayerZero or the
 *   OApp's owner gave up on the message.
 * - `UNRESOLVABLE_COMMAND`, `MALFORMED_COMMAND`: lzRead outcomes, never an OFT
 *   transfer's; final if they ever appear.
 */
const OUTCOME_OF: Record<
  LayerZeroScanStatus,
  'travelling' | 'delivered' | 'failed'
> = {
  INFLIGHT: 'travelling',
  CONFIRMING: 'travelling',
  BLOCKED: 'travelling',
  PAYLOAD_STORED: 'travelling',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  APPLICATION_BURNED: 'failed',
  APPLICATION_SKIPPED: 'failed',
  UNRESOLVABLE_COMMAND: 'failed',
  MALFORMED_COMMAND: 'failed',
};

/**
 * The message a lookup answered for this transfer: the one with its guid when
 * the guid is known, else the one sent from Stellar. Null when there is none.
 */
export function pickMessage(
  response: LayerZeroScanResponse | null,
  guid: string | null,
  srcEid: number,
): LayerZeroScanMessage | null {
  const messages = Array.isArray(response?.data) ? response.data : [];
  if (guid) {
    const byGuid = messages.find(
      (m) => m.guid?.toLowerCase() === guid.toLowerCase(),
    );
    if (byGuid) return byGuid;
  }
  return messages.find((m) => m.pathway?.srcEid === srcEid) ?? null;
}

/**
 * What a message's status means for the transfer. A status this table does not
 * know is `travelling`: the transfer stays SUBMITTED and is asked about again,
 * rather than being finalized on a word nobody mapped.
 */
export function scanOutcome(message: LayerZeroScanMessage): ScanOutcome {
  const scanStatus = message.status?.name ?? 'UNKNOWN';
  const guid = /^0x[0-9a-fA-F]{64}$/.test(message.guid ?? '')
    ? message.guid!.toLowerCase()
    : null;
  const outcome = (LAYERZERO_SCAN_STATUSES as readonly string[]).includes(
    scanStatus,
  )
    ? OUTCOME_OF[scanStatus as LayerZeroScanStatus]
    : 'travelling';
  if (outcome === 'delivered') {
    return {
      kind: 'delivered',
      scanStatus,
      guid,
      destinationTxHash: message.destination?.tx?.txHash ?? null,
    };
  }
  if (outcome === 'failed') {
    const detail = message.status?.message?.trim();
    return {
      kind: 'failed',
      scanStatus,
      guid,
      reason: `LayerZero reports the message ${scanStatus}${detail ? `: ${detail}` : ''}`,
    };
  }
  return { kind: 'travelling', scanStatus, guid };
}
