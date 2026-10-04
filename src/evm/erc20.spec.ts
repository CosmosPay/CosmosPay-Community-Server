import { approveCalldata } from '@/evm/erc20';

describe('approveCalldata', () => {
  it('approves exactly the amount sold to exactly the router', () => {
    expect(
      approveCalldata('0xb3e6778480b2E488385E8205eA05E20060B813cb', 1_000_000n),
    ).toBe(
      '0x095ea7b3' +
        '000000000000000000000000b3e6778480b2e488385e8205ea05e20060b813cb' +
        '00000000000000000000000000000000000000000000000000000000000f4240',
    );
  });
});
