import 'reflect-metadata';
import { createCache } from 'cache-manager';
import Keyv from 'keyv';
import {
  buildKeyvRedisStore,
  normalizeCacheNamespace,
} from './keyv-redis-cache';

/**
 * Replace the KeyvRedis adapter's real client with an in-memory stub so no
 * socket is opened, and capture every command the adapter issues to Redis.
 * Returns the ordered list of `[op, key, opts?]` tuples the adapter sends.
 */
function stubRedisClient(keyv: Keyv) {
  const seen: Array<[string, string, unknown?]> = [];
  const backing = new Map<string, string>();
  // The underlying @keyv/redis adapter is stored on the Keyv opts.
  const store = (keyv as unknown as { opts: { store: { getClient: unknown } } })
    .opts.store;
  store.getClient = async () => ({
    isOpen: true,
    set: (key: string, value: string, opts?: unknown) => {
      seen.push(['set', key, opts]);
      backing.set(key, value);
      return Promise.resolve('OK');
    },
    get: (key: string) => {
      seen.push(['get', key]);
      return Promise.resolve(backing.get(key));
    },
    del: (key: string) => {
      seen.push(['del', key]);
      backing.delete(key);
      return Promise.resolve(1);
    },
  });
  return seen;
}

describe('keyv-redis-cache', () => {
  describe('normalizeCacheNamespace', () => {
    it('returns undefined for unset/empty/colon-only (no prefix)', () => {
      expect(normalizeCacheNamespace(undefined)).toBeUndefined();
      expect(normalizeCacheNamespace('')).toBeUndefined();
      expect(normalizeCacheNamespace(':')).toBeUndefined();
    });

    it('strips trailing colons only, preserving internal ones', () => {
      expect(normalizeCacheNamespace('stg:')).toBe('stg');
      expect(normalizeCacheNamespace('stg')).toBe('stg');
      expect(normalizeCacheNamespace('v3:')).toBe('v3');
      expect(normalizeCacheNamespace('stg:v3:')).toBe('stg:v3');
      expect(normalizeCacheNamespace('stg::')).toBe('stg');
    });
  });

  describe('buildKeyvRedisStore', () => {
    it('returns a Keyv backed by a redis adapter (a real store, not memory)', () => {
      const keyv = buildKeyvRedisStore({
        url: 'redis://x:6379',
        namespace: 'stg',
        ttlMs: 3_600_000,
      });
      expect(keyv).toBeInstanceOf(Keyv);
      // The adapter is @keyv/redis, whose class name is KeyvRedis.
      const store = (
        keyv as unknown as {
          opts: { store: { constructor: { name: string } } };
        }
      ).opts.store;
      expect(store.constructor.name).toBe('KeyvRedis');
    });

    it('writes `<namespace>:<key>` to Redis and reads it back (single-colon prefix)', async () => {
      const keyv = buildKeyvRedisStore({
        url: 'redis://x:6379',
        namespace: 'stg',
        ttlMs: 3_600_000,
      });
      const seen = stubRedisClient(keyv);

      await keyv.set('fingerprint:abc', '1', 7_200_000);
      const value = await keyv.get('fingerprint:abc');

      expect(value).toBe('1');
      // Exactly one prefix layer -> `stg:` not `stg::stg:`.
      expect(seen[0]).toEqual([
        'set',
        'stg:fingerprint:abc',
        { PX: 7_200_000 },
      ]);
      expect(seen[1]).toEqual(['get', 'stg:fingerprint:abc']);
    });

    it('writes unprefixed keys when no namespace is set', async () => {
      const keyv = buildKeyvRedisStore({
        url: 'redis://x:6379',
        namespace: undefined,
        ttlMs: 3_600_000,
      });
      const seen = stubRedisClient(keyv);

      await keyv.set('fingerprint:abc', '1', 7_200_000);

      expect(seen[0]).toEqual(['set', 'fingerprint:abc', { PX: 7_200_000 }]);
    });

    it('applies the multi-segment `stg:v3` namespace as one prefix', async () => {
      const keyv = buildKeyvRedisStore({
        url: 'redis://x:6379',
        namespace: normalizeCacheNamespace('stg:v3:'),
        ttlMs: 3_600_000,
      });
      const seen = stubRedisClient(keyv);

      await keyv.set('country-codes', '[]', 1_800_000);

      expect(seen[0]).toEqual([
        'set',
        'stg:v3:country-codes',
        { PX: 1_800_000 },
      ]);
    });

    it('propagates the caller TTL to Redis as a PX (ms) expiration', async () => {
      const keyv = buildKeyvRedisStore({
        url: 'redis://x:6379',
        namespace: 'stg',
        ttlMs: 3_600_000,
      });
      const seen = stubRedisClient(keyv);

      // Explicit 2h TTL (as callers pass milliseconds).
      await keyv.set('k1', 'v', 7_200_000);
      // No explicit TTL -> falls back to the default ttlMs, still as PX.
      await keyv.set('k2', 'v');

      expect(seen[0]).toEqual(['set', 'stg:k1', { PX: 7_200_000 }]);
      expect(seen[1]).toEqual(['set', 'stg:k2', { PX: 3_600_000 }]);
    });

    it('is consumable via cache-manager createCache `stores: [keyv]` (v7 wiring)', async () => {
      const keyv = buildKeyvRedisStore({
        url: 'redis://x:6379',
        namespace: 'stg',
        ttlMs: 3_600_000,
      });
      const seen = stubRedisClient(keyv);

      const cache = createCache({ stores: [keyv], ttl: 3_600_000 });
      await cache.set('fingerprint:abc', '1', 7_200_000);
      const value = await cache.get<string>('fingerprint:abc');

      expect(value).toBe('1');
      expect(seen[0]).toEqual([
        'set',
        'stg:fingerprint:abc',
        { PX: 7_200_000 },
      ]);
    });

    it('does not crash the process on a store `error` event (boot resilience)', () => {
      const keyv = buildKeyvRedisStore({
        url: 'redis://unreachable:6379',
        namespace: 'stg',
        ttlMs: 3_600_000,
      });
      // An unhandled 'error' on the emitter would throw here and crash Node.
      expect(() => keyv.emit('error', new Error('ECONNREFUSED'))).not.toThrow();
      // Non-Error payloads (Keyv can emit strings) are also swallowed + logged.
      expect(() =>
        keyv.emit('error', 'symbol cannot be serialized'),
      ).not.toThrow();
    });
  });
});
