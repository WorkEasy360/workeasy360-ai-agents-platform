/**
 * Small in-process cache for data that rarely changes and is read on almost every request (plan limits,
 * the model catalog, an organization's workspace). The production database is in another region, so each
 * avoided query saves ~150 ms. Writers call `delete`/`clear` after changing the data; the TTL bounds how
 * stale another process (the worker) can be.
 *
 * CACHE_TTL_MS overrides every TTL (tests set 0 to disable caching).
 */
export function ttlCache<K, V>(ttlMs: number) {
  const ttl = process.env.CACHE_TTL_MS === undefined ? ttlMs : Number(process.env.CACHE_TTL_MS);
  const entries = new Map<K, { value: Promise<V>; expires: number }>();
  return {
    async get(key: K, load: () => Promise<V>): Promise<V> {
      if (ttl <= 0) return load();
      const hit = entries.get(key);
      if (hit && hit.expires > Date.now()) return hit.value;
      // Cache the promise, so concurrent requests share one query; forget it if the query fails.
      const value = load();
      entries.set(key, { value, expires: Date.now() + ttl });
      value.catch(() => entries.delete(key));
      if (entries.size > 10_000) entries.delete(entries.keys().next().value as K);
      return value;
    },
    delete(key: K) {
      entries.delete(key);
    },
    clear() {
      entries.clear();
    },
  };
}
