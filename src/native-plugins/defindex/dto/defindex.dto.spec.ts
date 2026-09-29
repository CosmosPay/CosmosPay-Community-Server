import { defindexAmount } from '@/defindex/dto/defindex.dto';

describe('defindexAmount', () => {
  it('preserves exact protocol minor units inside the SDK safe range', () => {
    expect(defindexAmount('10000000')).toBe(10_000_000);
  });

  it('refuses an amount the number-based SDK cannot represent exactly', () => {
    expect(() => defindexAmount('9007199254740992')).toThrow('safe integer');
  });
});
