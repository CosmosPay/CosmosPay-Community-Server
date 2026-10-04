import { addressTopic, eip681Uri, topicAddress } from '@/evm/eip681';

const PAYEE = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const TOKEN = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';

describe('eip681Uri', () => {
  it('pays the native coin by value, in wei, on the chain id', () => {
    expect(
      eip681Uri({ chainId: 143, recipient: PAYEE, value: 10n ** 18n }),
    ).toBe(`ethereum:${PAYEE}@143?value=1000000000000000000`);
  });

  it('pays an ERC-20 through transfer(address,uint256) on the token', () => {
    expect(
      eip681Uri({
        chainId: 10143,
        recipient: PAYEE,
        value: 2_500_000n,
        token: TOKEN,
      }),
    ).toBe(`ethereum:${TOKEN}@10143/transfer?address=${PAYEE}&uint256=2500000`);
  });
});

describe('log topics', () => {
  it('pads an address to a 32-byte topic and reads it back', () => {
    const topic = addressTopic(PAYEE);
    expect(topic).toHaveLength(66);
    expect(topic.endsWith(PAYEE.slice(2).toLowerCase())).toBe(true);
    expect(topicAddress(topic)).toBe(PAYEE.toLowerCase());
  });
});
