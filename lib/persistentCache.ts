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
// performance optimization, not something real functionality should depend on. That
// includes hangs, not just outright errors: if Vercel's network can't reach Redis for
// any reason, a plain try/catch around a stuck connect()/get() would never fire at all
// — the request would just hang. Every operation here is raced against a hard timeout
// specifically so "Redis is unreachable" degrades to "slightly slower, still works"
// instead of "the page hangs."
const CACHE_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); }
    );
  });
}

let client: RedisClientType | null = null;
let connecting: Promise<RedisClientType> | null = null;

async function getClient(): Promise<RedisClientType> {
  if (client?.isOpen) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    const url = process.env.storage_REDIS_URL;
    if (!url) throw new Error('storage_REDIS_URL is not set');
    const c: RedisClientType = createClient({ url, socket: { connectTimeout: CACHE_TIMEOUT_MS } });
    c.on('error', (err) => console.error('Redis client error:', err));
    await withTimeout(c.connect() as unknown as Promise<unknown>, CACHE_TIMEOUT_MS, 'Redis connect');
    client = c;
    connecting = null;
    return c;
  })();
  try {
    return await connecting;
  } catch (err) {
    connecting = null;
    throw err;
  }
}

// Same shape as unstable_cache's get-or-compute-and-store pattern, but persisted in
// Redis instead of Vercel's per-deployment Data Cache.
export async function getOrSetPersistent<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>
): Promise<T> {
  // compute() deliberately runs OUTSIDE the cache try/catch: it used to sit inside,
  // which meant a compute failure (e.g. the deliberately-thrown WCL rate-limit error)
  // was caught, logged misleadingly as "cache unavailable", and compute was run a
  // SECOND time — doubling the exact WCL request that had just been rate-limited.
  // Cache errors degrade to uncached compute; compute errors are the caller's to see.
  let redis: RedisClientType | null = null;
  try {
    redis = await getClient();
    const cached = await withTimeout(redis.get(key), CACHE_TIMEOUT_MS, 'Redis get');
    if (cached != null) return JSON.parse(cached) as T;
  } catch (err) {
    console.error('Persistent cache unavailable, computing uncached:', err);
    redis = null;
  }
  const fresh = await compute();
  if (redis) {
    // Awaited, not fire-and-forget: Vercel can freeze the function right after the
    // response returns, so an unawaited write may silently never land (same failure
    // mode logPointsUsage hit — confirmed live). withTimeout bounds the added latency.
    try {
      await withTimeout(redis.set(key, JSON.stringify(fresh), { EX: ttlSeconds }), CACHE_TIMEOUT_MS, 'Redis set');
    } catch (err) {
      console.error('Persistent cache write failed:', err);
    }
  }
  return fresh;
}

// Read-only peek at a plain (non-SWR) cache entry. Lets the website's rendering path
// reuse data the crawl already paid for WITHOUT contributing any writes of its own —
// the instance sits near its memory ceiling on a noeviction policy (hit it once,
// confirmed live), so organic traffic must never grow Redis.
export async function getPersistentReadOnly<T>(key: string): Promise<T | null> {
  try {
    const redis = await getClient();
    const cached = await withTimeout(redis.get(key), CACHE_TIMEOUT_MS, 'Redis get');
    return cached != null ? (JSON.parse(cached) as T) : null;
  } catch {
    return null;
  }
}

// Plain write. ttlSeconds omitted ⇒ no expiry — reserve that for small, effectively
// static data (e.g. the talent entry→node map): under volatile-lru or the headroom
// janitor, non-expiring keys are exactly the ones that survive.
export async function setPersistentValue<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
  try {
    const redis = await getClient();
    await withTimeout(
      redis.set(key, JSON.stringify(value), ttlSeconds ? { EX: ttlSeconds } : {}),
      CACHE_TIMEOUT_MS,
      'Redis set'
    );
  } catch (err) {
    console.error('Persistent value write failed:', err);
  }
}

// ─── Serve-stale-while-revalidate entries ────────────────────────────────────────

// Wrapper format for cache entries whose age matters: the stored value carries its
// write timestamp so callers can distinguish "fresh enough to serve as-is" from
// "servable, but kick off a background refresh". The Redis TTL is the hard ceiling
// on staleness; freshness within that window is the caller's policy.
export interface SwrHit<T> {
  value: T;
  ageSeconds: number;
}

export async function getSwrEntry<T>(key: string): Promise<SwrHit<T> | null> {
  try {
    const redis = await getClient();
    const cached = await withTimeout(redis.get(key), CACHE_TIMEOUT_MS, 'Redis get');
    if (cached == null) return null;
    const parsed = JSON.parse(cached);
    if (parsed && typeof parsed === 'object' && typeof parsed.__at === 'number') {
      return { value: parsed.v as T, ageSeconds: (Date.now() - parsed.__at) / 1000 };
    }
    return null; // unrecognized format — treat as a miss, the caller recomputes
  } catch (err) {
    console.error('SWR cache read failed, treating as miss:', err);
    return null;
  }
}

export async function setSwrEntry<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  try {
    const redis = await getClient();
    await withTimeout(
      redis.set(key, JSON.stringify({ __at: Date.now(), v: value }), { EX: ttlSeconds }),
      CACHE_TIMEOUT_MS,
      'Redis set'
    );
  } catch (err) {
    console.error('SWR cache write failed:', err);
  }
}

// Best-effort mutex so N concurrent requests to the same stale key produce one
// background refresh, not N. Expiry-based: a crashed holder just delays the next
// refresh attempt by the lock TTL, never wedges the key permanently.
export async function tryAcquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  try {
    const redis = await getClient();
    const res = await withTimeout(
      redis.set(key, '1', { NX: true, EX: ttlSeconds }),
      CACHE_TIMEOUT_MS,
      'Redis lock'
    );
    return res === 'OK';
  } catch {
    // Redis unreachable — the cache read failed too, so there's nothing stale being
    // served that would need refreshing. Declining the lock is the safe answer.
    return false;
  }
}

// ─── Memory headroom janitor ─────────────────────────────────────────────────────

// The managed instance enforces a hard memory cap with a noeviction policy and
// rejects CONFIG SET (verified live 2026-08-19) — at the ceiling, writes simply fail
// (hit once in production). This is the app-level substitute: before heavy write
// phases, if usage is near the cap, delete telemetry batch entries — the bulkiest
// pure-cache keys — oldest first (ascending remaining TTL ≙ oldest, since all are
// written with the same TTL). Evicted entries just recompute on next use.
//
// Throttled to once per hour via an NX marker so the check itself costs nothing on
// the hot path. All failures are swallowed: this is an optimization, never a gate.
const HEADROOM_CHECK_MARKER = 'redis-headroom-check';
// 10 min, not an hour: the first warm sweep wrote ~150MB in ~40 minutes and blew
// straight past the ceiling between hourly checks — writes were silently OOM-rejected
// for the rest of the run. The check is one INFO call when the marker has expired.
const HEADROOM_CHECK_INTERVAL_SECONDS = 600;
const HEADROOM_SOFT_LIMIT_BYTES = 200 * 1024 * 1024;
const HEADROOM_TARGET_BYTES = 170 * 1024 * 1024;
const HEADROOM_MAX_DELETIONS = 800;

export async function ensureRedisHeadroom(): Promise<void> {
  try {
    const redis = await getClient();
    const marker = await withTimeout(
      redis.set(HEADROOM_CHECK_MARKER, '1', { NX: true, EX: HEADROOM_CHECK_INTERVAL_SECONDS }),
      CACHE_TIMEOUT_MS, 'Redis headroom marker'
    );
    if (marker !== 'OK') return; // checked within the last hour

    const usedBytes = async () => {
      const info = await withTimeout(redis.info('memory'), CACHE_TIMEOUT_MS, 'Redis info');
      return parseInt((info.match(/used_memory:(\d+)/) ?? [])[1] ?? '0');
    };
    if ((await usedBytes()) < HEADROOM_SOFT_LIMIT_BYTES) return;

    // Collect telemetry batch keys with their remaining TTLs, evict oldest first.
    const candidates: Array<{ key: string; ttl: number }> = [];
    let cursor: string | number = '0';
    do {
      const res: any = await redis.scan(cursor as any, { MATCH: 'wcl-telemetry-batch-*', COUNT: 500 });
      cursor = res.cursor;
      for (const key of res.keys) {
        const ttl = await redis.ttl(key);
        if (ttl > 0) candidates.push({ key, ttl });
      }
    } while (String(cursor) !== '0');
    candidates.sort((a, b) => a.ttl - b.ttl);

    let deleted = 0;
    for (const { key } of candidates) {
      if (deleted >= HEADROOM_MAX_DELETIONS) break;
      await redis.del(key);
      deleted++;
      if (deleted % 100 === 0 && (await usedBytes()) < HEADROOM_TARGET_BYTES) break;
    }
    console.log(`Redis headroom janitor: evicted ${deleted} telemetry entries`);
  } catch (err) {
    console.error('Redis headroom check failed (ignored):', err);
  }
}

// ─── WCL points usage log ───────────────────────────────────────────────────────

// Diagnostic-only: how many WCL points a single combo's rankings+telemetry work
// actually costs, measured directly (points-before vs points-after) rather than
// guessed at. Written during crawls so real numbers are available afterward instead
// of reasoning from indirect signals (pause counts, request counts) like before.
// Bounded list — trimmed to the most recent entries so it can't grow unbounded across
// many crawls.
const POINTS_LOG_KEY = 'wcl-points-usage-log';
const POINTS_LOG_MAX_ENTRIES = 5000;

export interface PointsUsageEntry {
  combo: string;
  points: number | null; // null when it couldn't be measured (e.g. the hourly window rolled over mid-combo)
  ts: number;
}

// Awaited by callers deliberately — Vercel can freeze/tear down a serverless function
// immediately after it returns a response, so an unawaited write here has no guarantee
// of ever actually landing (confirmed live: a fire-and-forget version of this logged
// zero entries despite requests succeeding normally). Swallows its own errors — a full
// Redis instance (noeviction policy, confirmed live via an OOM error on rPush) or any
// other cache failure should never break a real response over diagnostic logging.
export async function logPointsUsage(entry: PointsUsageEntry): Promise<void> {
  try {
    const redis = await getClient();
    await withTimeout(redis.rPush(POINTS_LOG_KEY, JSON.stringify(entry)), CACHE_TIMEOUT_MS, 'Redis rPush');
    await withTimeout(redis.lTrim(POINTS_LOG_KEY, -POINTS_LOG_MAX_ENTRIES, -1), CACHE_TIMEOUT_MS, 'Redis lTrim').catch(() => {});
  } catch (err) {
    console.error('Points usage log write failed:', err);
  }
}

export async function getPointsUsageLog(limit = POINTS_LOG_MAX_ENTRIES): Promise<PointsUsageEntry[]> {
  const redis = await getClient();
  const raw = await withTimeout(redis.lRange(POINTS_LOG_KEY, -limit, -1), CACHE_TIMEOUT_MS, 'Redis lRange');
  return raw.map(r => JSON.parse(r));
}

export async function clearPointsUsageLog(): Promise<void> {
  const redis = await getClient();
  await redis.del(POINTS_LOG_KEY);
}
