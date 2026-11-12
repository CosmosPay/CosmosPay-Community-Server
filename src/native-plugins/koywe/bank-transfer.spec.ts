import {
  compareDecimals,
  decimalString,
  distinctAmount,
  matchDeposit,
  effectiveTransferStatus,
  retryDelayMs,
  shortReason,
  transferExpiry,
} from '@/native-plugins/koywe/bank-transfer';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

describe('bank transfer rules', () => {
  it('reads an awaiting transfer past its expiry as expired, and nothing else', () => {
    const row = {
      id: 't1',
      status: 'awaiting_deposit',
      expiresAt: new Date(NOW.getTime() + HOUR),
    };

    expect(effectiveTransferStatus(row, NOW)).toBe('awaiting_deposit');
    expect(
      effectiveTransferStatus(row, new Date(NOW.getTime() + 2 * HOUR)),
    ).toBe('expired');
    for (const status of ['converting', 'completed', 'failed']) {
      expect(
        effectiveTransferStatus(
          { ...row, status },
          new Date(NOW.getTime() + 2 * HOUR),
        ),
      ).toBe(status);
    }
    expect(() =>
      effectiveTransferStatus({ ...row, status: 'expired' }, NOW),
    ).toThrow('Bank transfer t1 has unknown status "expired"');
  });

  it('gives a transfer an hour, never past its request', () => {
    expect(transferExpiry(NOW, new Date(NOW.getTime() + 3 * HOUR))).toEqual(
      new Date(NOW.getTime() + HOUR),
    );
    const soon = new Date(NOW.getTime() + 10 * 60 * 1000);
    expect(transferExpiry(NOW, soon)).toEqual(soon);
  });

  it('compares decimal amounts exactly', () => {
    expect(compareDecimals('15000', '15000.00')).toBe(0);
    expect(compareDecimals('15000', '15000.01')).toBe(-1);
    expect(compareDecimals('15000.1', '15000.09')).toBe(1);
    expect(compareDecimals('0.30000000000000004', '0.3')).toBe(1);
    expect(
      compareDecimals('99999999999999999999', '99999999999999999998'),
    ).toBe(1);
    expect(() => compareDecimals('1e3', '1000')).toThrow();
  });

  it('reads a provider amount as a plain decimal string, never in exponent form', () => {
    expect(decimalString(15000)).toBe('15000');
    expect(decimalString(8.94)).toBe('8.94');
    expect(decimalString(0.0000001)).toBe('0.0000001');
    expect(decimalString(' 12.5 ')).toBe('12.5');
    for (const raw of [-1, Number.NaN, Infinity, '1e5', 'abc', '', null, {}]) {
      expect(decimalString(raw)).toBeNull();
    }
  });

  it('retries a minute later, doubling, at most an hour', () => {
    expect(retryDelayMs(0)).toBe(60_000);
    expect(retryDelayMs(1)).toBe(120_000);
    expect(retryDelayMs(5)).toBe(32 * 60_000);
    expect(retryDelayMs(6)).toBe(HOUR);
    expect(retryDelayMs(500)).toBe(HOUR);
  });

  it('keeps a reason to one bounded line', () => {
    expect(shortReason('the provider\nsaid  no')).toBe('the provider said no');
    const long = shortReason('x'.repeat(500));
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
  });

  describe('distinct amounts per depositor', () => {
    it('asks the request amount when no open transfer of the depositor asks it', () => {
      expect(distinctAmount('15000', [])).toBe('15000');
      expect(distinctAmount('15000', ['20000', '15000.01'])).toBe('15000');
    });

    it('adds the first free cents when another charge asks the same amount', () => {
      expect(distinctAmount('15000', ['15000'])).toBe('15000.01');
      expect(
        distinctAmount('15000', ['15000.00', '15000.01', '15000.02']),
      ).toBe('15000.03');
      expect(distinctAmount('15000.50', ['15000.5'])).toBe('15000.51');
      expect(distinctAmount('15000.99', ['15000.99'])).toBe('15001');
    });

    it('gives up after 0.99', () => {
      const taken = Array.from({ length: 100 }, (_, cents) =>
        (15000 + cents / 100).toFixed(2),
      );
      expect(distinctAmount('15000', taken)).toBeNull();
      expect(distinctAmount('15000', taken.slice(0, 99))).toBe('15000.99');
    });
  });

  describe('which transfer a deposit pays', () => {
    const t = (id: string, instructedAmount: string) => ({
      id,
      instructedAmount,
    });

    it('pays the transfer asking exactly the deposit, whatever its age', () => {
      const candidates = [t('old', '15000'), t('new', '20000')];

      expect(matchDeposit(candidates, '20000').match?.id).toBe('new');
      expect(matchDeposit(candidates, '15000.00').match?.id).toBe('old');
    });

    it('takes an overpayment only when the depositor has one open transfer', () => {
      expect(matchDeposit([t('only', '15000')], '15500').match?.id).toBe(
        'only',
      );
      const two = matchDeposit([t('a', '15000'), t('b', '20000')], '25000');
      expect(two.match).toBeNull();
      expect(two.reason).toBe(
        'no open transfer asks exactly this amount, and 2 could take it',
      );
    });

    it('pays nothing short of the transfer, nothing without one, nothing on a tie', () => {
      expect(matchDeposit([t('only', '15000')], '14999.99')).toEqual({
        match: null,
        reason: 'short of the open transfer for this depositor',
      });
      expect(matchDeposit([], '15000')).toEqual({
        match: null,
        reason: 'no open transfer for this depositor',
      });
      expect(
        matchDeposit([t('a', '15000'), t('b', '15000')], '15000').match,
      ).toBeNull();
    });
  });
});
