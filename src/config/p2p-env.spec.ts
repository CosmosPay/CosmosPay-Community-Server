import {
  assertP2pConfigConsistent,
  parseP2pNetworkJson,
  isContractValue,
} from '@/config/p2p-env';

const CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const MATCHER = `0x${'6a'.repeat(32)}`;
const DATA_KEY = Buffer.alloc(32, 7).toString('base64');

function testnet(extra: Record<string, unknown> = {}) {
  return {
    P2P_MARKET_CONTRACTS_TESTNET: JSON.stringify({ base: CONTRACT }),
    P2P_MARKET_DEPLOY_BLOCKS_TESTNET: JSON.stringify({ base: 100 }),
    P2P_MATCHER_PRIVATE_KEY: MATCHER,
    P2P_DATA_ENCRYPTION_KEY: DATA_KEY,
    ...extra,
  };
}

describe('P2P market environment', () => {
  it('boots with nothing set: the market is simply off', () => {
    expect(() => assertP2pConfigConsistent({})).not.toThrow();
  });

  it('takes a testnet set, the node defaulting to the sandbox’s public one', () => {
    expect(() => assertP2pConfigConsistent(testnet())).not.toThrow();
  });

  it('refuses a tier with contracts but no matcher or data key', () => {
    expect(() =>
      assertP2pConfigConsistent(
        testnet({ P2P_MATCHER_PRIVATE_KEY: '', P2P_DATA_ENCRYPTION_KEY: '' }),
      ),
    ).toThrow('P2P_MATCHER_PRIVATE_KEY and P2P_DATA_ENCRYPTION_KEY are not');
  });

  it('refuses a deployment without its start block', () => {
    expect(() =>
      assertP2pConfigConsistent(
        testnet({ P2P_MARKET_DEPLOY_BLOCKS_TESTNET: '{}' }),
      ),
    ).toThrow('has no block for base');
  });

  it('refuses a mainnet network without the operator’s own node', () => {
    expect(() =>
      assertP2pConfigConsistent({
        ...testnet(),
        P2P_MARKET_CONTRACTS_MAINNET: JSON.stringify({ base: CONTRACT }),
        P2P_MARKET_DEPLOY_BLOCKS_MAINNET: JSON.stringify({ base: 1 }),
      }),
    ).toThrow('P2P_RPC_URLS_MAINNET has no node for base');
    expect(() =>
      assertP2pConfigConsistent({
        ...testnet(),
        P2P_MARKET_CONTRACTS_MAINNET: JSON.stringify({ base: CONTRACT }),
        P2P_MARKET_DEPLOY_BLOCKS_MAINNET: JSON.stringify({ base: 1 }),
        P2P_RPC_URLS_MAINNET: JSON.stringify({ base: 'https://node.example' }),
      }),
    ).not.toThrow();
  });

  it('refuses a network the market does not run on for that tier', () => {
    // Robinhood Chain has no mainnet chain id in the verified tables.
    expect(() =>
      assertP2pConfigConsistent({
        ...testnet(),
        P2P_MARKET_CONTRACTS_MAINNET: JSON.stringify({ hood: CONTRACT }),
        P2P_MARKET_DEPLOY_BLOCKS_MAINNET: JSON.stringify({ hood: 1 }),
        P2P_RPC_URLS_MAINNET: JSON.stringify({ hood: 'https://node.example' }),
      }),
    ).toThrow('does not run on public');
  });

  it('refuses a start block or a node for a network with no contract', () => {
    expect(() =>
      assertP2pConfigConsistent(
        testnet({
          P2P_MARKET_DEPLOY_BLOCKS_TESTNET: JSON.stringify({ base: 1, arb: 2 }),
        }),
      ),
    ).toThrow('names arb, which has no contract');
  });

  it('refuses a matcher key that is the relayer’s or the sandbox treasury’s', () => {
    expect(() =>
      assertP2pConfigConsistent(
        testnet({
          MONAD_RELAYER_PRIVATE_KEY: MATCHER.toUpperCase().replace('0X', '0x'),
        }),
      ),
    ).toThrow('must not be MONAD_RELAYER_PRIVATE_KEY');
    expect(() =>
      assertP2pConfigConsistent(
        testnet({ SANDBOX_TREASURY_PRIVATE_KEY: MATCHER.slice(2) }),
      ),
    ).toThrow('must not be SANDBOX_TREASURY_PRIVATE_KEY');
  });

  it('refuses malformed keys', () => {
    expect(() =>
      assertP2pConfigConsistent(testnet({ P2P_MATCHER_PRIVATE_KEY: '0x12' })),
    ).toThrow('32-byte hex secret key');
    expect(() =>
      assertP2pConfigConsistent(
        testnet({ P2P_MATCHER_PRIVATE_KEY: `0x${'0'.repeat(64)}` }),
      ),
    ).toThrow('must not be zero');
    expect(() =>
      assertP2pConfigConsistent(testnet({ P2P_DATA_ENCRYPTION_KEY: 'short' })),
    ).toThrow('must be 32 bytes');
  });

  it('parses a network map, naming the variable on any mistake', () => {
    expect(parseP2pNetworkJson(undefined, 'X', isContractValue)).toEqual({});
    expect(
      parseP2pNetworkJson(
        JSON.stringify({ base: CONTRACT }),
        'X',
        isContractValue,
      ),
    ).toEqual({ base: CONTRACT });
    expect(() => parseP2pNetworkJson('[1]', 'X', isContractValue)).toThrow(
      'X must be a JSON object',
    );
    expect(() => parseP2pNetworkJson('{bad', 'X', isContractValue)).toThrow(
      'X must be a JSON object',
    );
    expect(() =>
      parseP2pNetworkJson(
        JSON.stringify({ solana: CONTRACT }),
        'X',
        isContractValue,
      ),
    ).toThrow('"solana" is not a P2P network id');
    expect(() =>
      parseP2pNetworkJson(
        JSON.stringify({ base: '0x12' }),
        'X',
        isContractValue,
      ),
    ).toThrow('the value for base is not valid');
  });
});
