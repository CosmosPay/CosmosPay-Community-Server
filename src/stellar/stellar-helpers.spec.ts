import { HttpStatus } from '@nestjs/common';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { ApiError, ApiErrorCode } from '../common/errors/api-error';
import { assetKey, assetLabel, resolveAsset } from './asset';
import {
  extractResultCodes,
  horizonStatus,
  isHorizonNotFound,
} from './horizon-errors';
import { MAX_UINT64, applyMemo, resolveMemoId } from './memo';

/**
 * These were four private copies each, spread across swaps, liquidity pools,
 * payment intents and products. Now that they are shared units they are worth
 * testing directly rather than only through whichever service happened to call
 * them — which is how the copies drifted in the first place.
 */
describe('resolveAsset', () => {
  it('treats an absent, empty, XLM or native code as lumens', () => {
    for (const code of [
      undefined,
      '',
      '  ',
      'XLM',
      'xlm',
      'native',
      'NATIVE',
    ]) {
      const resolved = resolveAsset(code);
      expect(resolved.code).toBe('native');
      expect(resolved.issuer).toBeNull();
      expect(resolved.asset.isNative()).toBe(true);
    }
  });

  it('ignores an issuer supplied alongside a native code', () => {
    expect(resolveAsset('XLM', 'GISSUER').issuer).toBeNull();
  });

  it('requires an issuer for anything else', () => {
    let thrown: unknown;
    try {
      resolveAsset('USDC');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect((thrown as ApiError).code).toBe(ApiErrorCode.ValidationFailed);
    expect((thrown as ApiError).message).toContain('USDC');
  });

  it('builds an issued asset and trims the code', () => {
    const issuer = Keypair.random().publicKey();
    const resolved = resolveAsset('  USDC  ', issuer);
    expect(resolved.code).toBe('USDC');
    expect(resolved.issuer).toBe(issuer);
    expect(resolved.asset.getCode()).toBe('USDC');
  });
});

describe('assetLabel', () => {
  it('renders lumens as XLM and everything else as its code', () => {
    expect(assetLabel('native')).toBe('XLM');
    expect(assetLabel('')).toBe('XLM');
    expect(assetLabel('USDC')).toBe('USDC');
    expect(assetLabel({ code: 'native' })).toBe('XLM');
    expect(assetLabel({ code: 'EURC' })).toBe('EURC');
  });
});

describe('assetKey', () => {
  it('matches how Horizon identifies a pool reserve', () => {
    expect(assetKey('native')).toBe('native');
    expect(assetKey('native', 'GISSUER')).toBe('native');
    expect(assetKey('USDC', null)).toBe('native');
    expect(assetKey('USDC', 'GISSUER')).toBe('USDC:GISSUER');
  });
});

describe('resolveMemoId', () => {
  it('returns null when no memo was given, but rejects an empty string', () => {
    expect(resolveMemoId(undefined)).toBeNull();
    expect(() => resolveMemoId('')).toThrow(ApiError);
  });

  it('accepts a uint64 up to the boundary and rejects one past it', () => {
    expect(resolveMemoId('0')).toBe('0');
    expect(resolveMemoId(MAX_UINT64.toString())).toBe(MAX_UINT64.toString());
    expect(() => resolveMemoId((MAX_UINT64 + 1n).toString())).toThrow(ApiError);
  });

  it('rejects anything that is not a plain decimal integer', () => {
    for (const bad of ['-1', '1.5', '0x10', '1e3', 'abc', ' 12', '12 ']) {
      let thrown: unknown;
      try {
        resolveMemoId(bad);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      expect((thrown as ApiError).code).toBe(ApiErrorCode.InvalidMemo);
    }
  });
});

describe('applyMemo', () => {
  function builder() {
    const addMemo = jest.fn();
    return { addMemo } as unknown as TransactionBuilder & {
      addMemo: jest.Mock;
    };
  }

  it('prefers the caller MEMO_ID over the commission label', () => {
    const b = builder();
    applyMemo(b, '12345', 'Cosmos Pay commission');
    expect(
      (b as unknown as { addMemo: jest.Mock }).addMemo,
    ).toHaveBeenCalledTimes(1);
    const memo = (b as unknown as { addMemo: jest.Mock }).addMemo.mock
      .calls[0][0] as { type: string; value: unknown };
    expect(memo.type).toBe('id');
  });

  it('falls back to the commission label only when a fee was collected', () => {
    const withFee = builder();
    applyMemo(withFee, null, 'Cosmos Pay commission');
    const memo = (withFee as unknown as { addMemo: jest.Mock }).addMemo.mock
      .calls[0][0] as { type: string };
    expect(memo.type).toBe('text');

    const noFee = builder();
    applyMemo(noFee, null, null);
    expect(
      (noFee as unknown as { addMemo: jest.Mock }).addMemo,
    ).not.toHaveBeenCalled();
  });
});

describe('horizon errors', () => {
  const withStatus = (status: number) => ({ response: { status } });

  it('distinguishes "not on chain" from "could not ask"', () => {
    // Conflating these is how settled transactions got expired during an outage.
    expect(isHorizonNotFound(withStatus(404))).toBe(true);
    for (const status of [429, 500, 502, 503, 504]) {
      expect(isHorizonNotFound(withStatus(status))).toBe(false);
    }
    expect(isHorizonNotFound(new Error('socket hang up'))).toBe(false);
    expect(horizonStatus(new Error('socket hang up'))).toBeUndefined();
  });

  it('reads result codes from either shape the SDK produces', () => {
    expect(
      extractResultCodes({
        response: {
          data: {
            extras: {
              result_codes: { transaction: 'tx_failed', operations: ['op_a'] },
            },
          },
        },
      }),
    ).toEqual(['tx_failed', 'op_a']);

    expect(
      extractResultCodes({
        response: { extras: { result_codes: { transaction: 'tx_bad_auth' } } },
      }),
    ).toEqual(['tx_bad_auth']);
  });

  it('returns null when there is nothing to report', () => {
    expect(extractResultCodes(new Error('boom'))).toBeNull();
    expect(extractResultCodes({ response: {} })).toBeNull();
    expect(
      extractResultCodes({ response: { extras: { result_codes: {} } } }),
    ).toBeNull();
  });
});
