import { ReadThroughCache } from '@/common/read-through-cache';

/** A clock the test moves by hand. */
function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('ReadThroughCache', () => {
  it('computes a key once and serves it until the ttl passes', async () => {
    const c = clock();
    const cache = new ReadThroughCache<number>(10_000, 10, c.now);
    const load = jest.fn().mockResolvedValue(42);

    await expect(cache.get('k', load)).resolves.toBe(42);
    c.advance(9_999);
    await expect(cache.get('k', load)).resolves.toBe(42);
    expect(load).toHaveBeenCalledTimes(1);

    c.advance(1);
    await cache.get('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one computation between callers that arrive while it runs', async () => {
    const cache = new ReadThroughCache<string>(10_000, 10);
    let resolve!: (v: string) => void;
    const load = jest.fn(() => new Promise<string>((r) => (resolve = r)));

    const calls = [
      cache.get('k', load),
      cache.get('k', load),
      cache.get('k', load),
    ];
    resolve('once');

    await expect(Promise.all(calls)).resolves.toEqual(['once', 'once', 'once']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never serves one key the value of another', async () => {
    const cache = new ReadThroughCache<string>(10_000, 10);

    await cache.get('consumer-a|testnet', () => Promise.resolve('a'));
    await expect(
      cache.get('consumer-b|testnet', () => Promise.resolve('b')),
    ).resolves.toBe('b');
    await expect(
      cache.get('consumer-a|public', () => Promise.resolve('a-public')),
    ).resolves.toBe('a-public');
  });

  it('does not keep a computation that failed', async () => {
    const cache = new ReadThroughCache<string>(10_000, 10);
    const load = jest
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce('back');

    await expect(cache.get('k', load)).rejects.toThrow('db down');
    await expect(cache.get('k', load)).resolves.toBe('back');
    expect(cache.size).toBe(1);
  });

  it('holds at most maxEntries keys, dropping the least recently read', async () => {
    const cache = new ReadThroughCache<string>(10_000, 2);
    const load = (v: string) => jest.fn().mockResolvedValue(v);

    await cache.get('a', load('a'));
    await cache.get('b', load('b'));
    await cache.get('a', load('a2')); // a is now the most recent
    await cache.get('c', load('c')); // evicts b

    expect(cache.size).toBe(2);
    const reloadA = load('a3');
    const reloadB = load('b2');
    await expect(cache.get('a', reloadA)).resolves.toBe('a');
    await expect(cache.get('b', reloadB)).resolves.toBe('b2');
    expect(reloadA).not.toHaveBeenCalled();
    expect(reloadB).toHaveBeenCalledTimes(1);
  });

  it('with a ttl of 0, computes every time and holds nothing', async () => {
    const cache = new ReadThroughCache<number>(0, 10);
    const load = jest.fn().mockResolvedValue(1);

    await cache.get('k', load);
    await cache.get('k', load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });
});
