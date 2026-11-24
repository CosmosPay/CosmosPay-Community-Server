import {
  isEvmAddressValue,
  isRpcUrl,
  parseNetworkMap,
} from '@/config/sandbox-env';

describe('parseNetworkMap', () => {
  it('reads net=value pairs, ignoring blanks', () => {
    expect(
      parseNetworkMap(
        ' bsc=0x' + 'a'.repeat(40) + ', ,gnosis=0x' + 'b'.repeat(40),
        'SANDBOX_CUSD_ADDRESSES',
        isEvmAddressValue,
      ),
    ).toEqual({ bsc: '0x' + 'a'.repeat(40), gnosis: '0x' + 'b'.repeat(40) });
    expect(parseNetworkMap(undefined, 'X', isRpcUrl)).toEqual({});
  });

  it('refuses an unknown network, a repeat and a bad value, naming the variable', () => {
    expect(() =>
      parseNetworkMap('mars=https://x.example', 'SANDBOX_RPC_URLS', isRpcUrl),
    ).toThrow(/SANDBOX_RPC_URLS: "mars" is not a payment network id/);
    expect(() =>
      parseNetworkMap(
        'eth=https://a.example,eth=https://b.example',
        'SANDBOX_RPC_URLS',
        isRpcUrl,
      ),
    ).toThrow(/listed twice/);
    expect(() =>
      parseNetworkMap('eth=ftp://a', 'SANDBOX_RPC_URLS', isRpcUrl),
    ).toThrow(/value for eth is not valid/);
  });
});
