import { createClient, type RedisClientType } from 'redis';

// Backs the WCL rankings/telemetry caching specifically — the data that's expensive
// (WCL rate limits) to refetch. unstable_cache's Next.js Data Cache gets wiped on every
// deployment, so its nominal 24h TTL was really "24h, or until the next deploy,
// whichever comes first" — during an active development session (many deploys/night)
// that meant almost every crawl re-fetched everything from scratch regardless of how
// recently it had already been fetched. This store is deploy-independent: it only
// forgets things when their TTL actually expires.
//
// Any failure here (connection down, Redis unreachable, malformed cached value) falls
// back to just computing fresh rather than failing the request — caching is a
// performance optimization, not something real functionality should depend on.

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType> | null = null;

async function getClient(): Promise<RedisClientType> {
  if (client?.isOpen) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const url = process.env.storage_REDIS_URL;
    if (!url) throw new Error('storage_REDIS_URL is not set');
    const c: RedisClientType = createClient({ url });
    c.on('error', (err) => console.error('Redis client error:', err));
    await c.connect();
    client = c;
    connecting = null;
    return c;
  })();
  return connecting;
}

// Same shape as unstable_cache's get-or-compute-and-store pattern, but persisted in
// Redis instead of Vercel's per-deployment Data Cache.
export async function getOrSetPersistent<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>
): Promise<T> {
  try {
    const redis = await getClient();
    const cached = await redis.get(key);
    if (cached != null) return JSON.parse(cached) as T;
    const fresh = await compute();
    // Fire-and-forget the write — a slow/failed cache write shouldn't delay or fail a
    // response that already has its real data.
    redis.set(key, JSON.stringify(fresh), { EX: ttlSeconds }).catch(err =>
      console.error('Persistent cache write failed:', err)
    );
    return fresh;
  } catch (err) {
    console.error('Persistent cache unavailable, computing uncached:', err);
    return compute();
  }
}
