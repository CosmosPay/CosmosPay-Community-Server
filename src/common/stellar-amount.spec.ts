import { Logger } from '@nestjs/common';
import {
  formatFixed7,
  fromStroops,
  parseAmountOrZero,
  toStroops,
} from './stellar-amount';

describe('stellar-amount', () => {
  describe('toStroops / fromStroops', () => {
    it('keeps the existing trimmed Stellar amount contract', () => {
      expect(fromStroops(toStroops('0'))).toBe('0');
      expect(fromStroops(toStroops('0.0000001'))).toBe('0.0000001');
      expect(fromStroops(toStroops('922337203685.4775807'))).toBe(
        '922337203685.4775807',
      );
    });

    it('rejects malformed or out-of-range values', () => {
      for (const amount of [
        '',
        'abc',
        '-1',
        '1.12345678',
        '922337203685.4775808',
      ]) {
        expect(() => toStroops(amount)).toThrow(RangeError);
      }
    });
  });

  describe('parseAmountOrZero', () => {
    it.each([['abc'], [''], [null], ['1.12345678'], ['1000000000000']])(
      'turns invalid legacy value %p into zero and warns',
      (amount) => {
        const warn = jest
          .spyOn(Logger.prototype, 'warn')
          .mockImplementation(() => undefined);

        expect(parseAmountOrZero(amount)).toBe(0n);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
      },
    );
  });

  describe('formatFixed7', () => {
    it('keeps exactly seven decimals without exponential notation', () => {
      expect(formatFixed7(0n)).toBe('0.0000000');
      expect(formatFixed7(1n)).toBe('0.0000001');
      expect(formatFixed7(toStroops('922337203685.4775807'))).toBe(
        '922337203685.4775807',
      );
    });
  });
});
