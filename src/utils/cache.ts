import { env } from '../config/env';

type Entry<T> = { value: T; expiresAt: number };

// Tiny in-process TTL cache. It only saves *repeat* upstream calls within a TTL
// window — the durable cache is the database (sync writes snapshots there). On a
// multi-instance deploy this is per-instance, which is fine: it's a courtesy
// layer to stay under CoinGecko's rate limits, not a source of truth.
const store = new Map<string, Entry<unknown>>();

export const cacheGet = <T>(key: string): T | undefined => {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return hit.value as T;
};

export const cacheSet = <T>(key: string, value: T, ttlSeconds = env.CACHE_TTL_SECONDS): void => {
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
};

/** Fetch-through helper: return cached value or run `loader` and cache its result. */
export const cached = async <T>(key: string, loader: () => Promise<T>, ttlSeconds?: number): Promise<T> => {
  const hit = cacheGet<T>(key);
  if (hit !== undefined) return hit;
  const value = await loader();
  cacheSet(key, value, ttlSeconds);
  return value;
};

export const cacheClear = (): void => store.clear();
