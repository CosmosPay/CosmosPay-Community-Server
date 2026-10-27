/**
 * A small in-process read-through cache for answers that many requests ask for at once: the
 * value for a key is computed once and shared, by every caller that arrives while it is being
 * computed (no thundering herd) and by every caller in the next `ttlMs`. A computation that
 * fails is not kept, so the next caller computes again. At most `maxEntries` keys are held; the
 * least recently read goes first.
 *
 * It lives in one process: each replica keeps its own, so two replicas can answer the same key
 * from different moments of the last `ttlMs`. Use it only where an answer that old is fine, and
 * build the key from everything the answer depends on (the consumer first, for tenant data), so
 * one caller can never be served another's.
 */
export class ReadThroughCache<V> {
  private readonly entries = new Map<
    string,
    { at: number; value: Promise<V> }
  >();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** The value for `key`: the cached or in-flight one, else `load()`'s. A ttl of 0 never caches. */
  get(key: string, load: () => Promise<V>): Promise<V> {
    if (this.ttlMs <= 0) return load();
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) {
      // Re-inserted, so the Map's order is the recency order the eviction reads.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.value;
    }
    const entry = { at: this.now(), value: load() };
    this.entries.delete(key);
    this.entries.set(key, entry);
    entry.value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return entry.value;
  }

  /** How many keys are held (for tests and diagnostics). */
  get size(): number {
    return this.entries.size;
  }
}
