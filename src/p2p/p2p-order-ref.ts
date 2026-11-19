import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex } from '@/evm/rlp';
import { ZERO_ADDRESS, type P2pOpenParams } from '@/p2p/p2p-market-abi';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * The `ref` an order carries on-chain: keccak-256 of its uuid's 16 bytes.
 * Deterministic, so the indexer finds the order by it, and unique per opener in
 * the contract (`orderIdOf(opener, ref)`), so nobody can take an order's ref
 * by opening first: their copy is under their own address.
 */
export function orderRef(id: string): string {
  if (!isUuid(id)) throw new Error(`order id ${id} is not a uuid`);
  return bytesToHex(keccak_256(Buffer.from(id.replace(/-/g, ''), 'hex')));
}

/** The columns of an order that make its `OpenParams`. */
export interface P2pOrderTerms {
  id: string;
  sellerAddress: string;
  buyerAddress: string;
  token: string;
  tokenAmount: string;
  bond: string;
  acceptWindow: number;
  paymentWindow: number;
  settleWindow: number;
  integratorAddress: string | null;
  integratorFeeBps: number;
}

/** The `OpenParams` an order is opened with, and checked against when indexed. */
export function openParamsOf(order: P2pOrderTerms): P2pOpenParams {
  return {
    ref: orderRef(order.id),
    seller: order.sellerAddress,
    buyer: order.buyerAddress,
    token: order.token,
    amount: BigInt(order.tokenAmount),
    bond: BigInt(order.bond),
    acceptWindow: order.acceptWindow,
    paymentWindow: order.paymentWindow,
    settleWindow: order.settleWindow,
    integrator:
      order.integratorFeeBps > 0 && order.integratorAddress
        ? order.integratorAddress
        : ZERO_ADDRESS,
    integratorFeeBps: order.integratorAddress ? order.integratorFeeBps : 0,
  };
}
