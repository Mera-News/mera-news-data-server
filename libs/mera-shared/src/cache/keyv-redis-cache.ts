import { Logger } from '@nestjs/common';
import Keyv from 'keyv';
import type { CacheManagerOptions } from '@nestjs/cache-manager';
import KeyvRedis from '@keyv/redis';

/**
 * Redis-backed cache wiring for `@nestjs/cache-manager` v3 + `cache-manager` v7.
 *
 * WHY THIS EXISTS
 * ---------------
 * cache-manager v7 dropped the legacy singular `store:` option. Its
 * `createCacheManager` reads ONLY `stores: Keyv[]` — a singular `store` (as
 * produced by `cache-manager-redis-yet`'s `redisStore()`) is silently ignored,
 * so every get/set falls through to an in-process memory Keyv and NOTHING ever
 * reaches Redis. This module builds the correct `stores: [Keyv]` shape with a
 * `@keyv/redis` adapter so Redis is genuinely used.
 *
 * ON-WIRE KEY FORMAT
 * ------------------
 * Keys are namespaced by CACHE_KEY_PREFIX. Keyv is the ONLY layer that
 * prefixes, using a single-colon separator, so the exact key written to Redis
 * is `<namespace>:<key>` (or `<key>` unprefixed when no prefix is set):
 *   - no prefix        -> `fingerprint:abc`
 *   - CACHE_KEY_PREFIX=stg:    -> `stg:fingerprint:abc`
 *   - CACHE_KEY_PREFIX=v3:     -> `v3:fingerprint:abc`
 *   - CACHE_KEY_PREFIX=stg:v3: -> `stg:v3:fingerprint:abc`
 * These prefixes are load-bearing: staging shares the prod Memorystore
 * instances and is isolated purely by them.
 */

/**
 * Normalize a raw CACHE_KEY_PREFIX into a Keyv namespace. Trailing colon(s) are
 * stripped because the namespace separator adds exactly one, so `stg`, `stg:`
 * and `stg::` all yield `stg`; an internal colon is preserved (`stg:v3:` ->
 * `stg:v3`). Empty/unset yields `undefined` — i.e. no prefix at all.
 */
export function normalizeCacheNamespace(raw?: string): string | undefined {
  const trimmed = (raw ?? '').replace(/:+$/, '');
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The Keyv instance type `CacheModule` expects in `stores: [...]`, taken from
 * @nestjs/cache-manager's own options so it is keyv's ESM declaration.
 *
 * Why it is not plain `Keyv`: @nestjs/cache-manager 12 ships as ESM and types
 * `stores` with keyv's `index.d.ts`, while this CommonJS code resolves keyv's
 * `index.d.cts`. The two `Keyv` classes are identical but nominally distinct to
 * TypeScript (private members), so the instance is retyped once, by
 * {@link asCacheModuleStore}. At
 * runtime Nest recognises it as a Keyv by shape and uses it unchanged,
 * namespace included.
 */
export type CacheStore = Extract<
  Extract<NonNullable<CacheManagerOptions['stores']>, unknown[]>[number],
  { hooks: unknown }
>;

export interface KeyvRedisStoreOptions {
  /** Redis connection URL. */
  url?: string;
  /** Already-normalized namespace (see {@link normalizeCacheNamespace}). */
  namespace?: string;
  /** Default TTL in milliseconds applied when a caller omits an explicit TTL. */
  ttlMs: number;
  /** Logger label for the error handler (defaults to a shared logger). */
  logContext?: string;
}

/**
 * Build a single `Keyv` instance backed by `@keyv/redis`, ready to hand to
 * `CacheModule` as `stores: [keyv]`. TTLs passed to `cacheManager.set(k, v, ms)`
 * propagate to Redis as a `PX` expiration (milliseconds), which matters because
 * the persistent instance runs `volatile-ttl` eviction — a key written without
 * an expiry would never be evictable.
 */
export function buildKeyvRedisStore(options: KeyvRedisStoreOptions): Keyv {
  const { url, namespace, ttlMs, logContext = 'KeyvRedisCache' } = options;
  const logger = new Logger(logContext);

  const store = new KeyvRedis(url);
  const keyv = new Keyv({ store, namespace, useKeyPrefix: true, ttl: ttlMs });

  // Keyv's constructor propagates its own namespace onto the underlying redis
  // store. If left in place, BOTH layers prefix and we get `stg::stg:key`.
  // Null the store's namespace so Keyv is the sole prefixer -> `stg:key`.
  store.namespace = undefined;

  // @keyv/redis re-emits connection/store errors on the Keyv emitter. An
  // unhandled 'error' event CRASHES the Node process, so a transient Redis
  // outage (e.g. at Cloud Run boot, before the health probe passes) would take
  // the whole service down. Swallow + log instead: cache-manager already
  // degrades reads to `undefined` and @keyv/redis swallows write failures by
  // default, so callers keep working against MongoDB while Redis is down.
  keyv.on('error', (err: unknown) => {
    logger.warn(
      `Redis cache error (degrading to source-of-truth): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });

  return keyv;
}

/**
 * Hand a {@link buildKeyvRedisStore} instance to `CacheModule`'s `stores`.
 * Returns the SAME object, only retyped from keyv's CJS declaration to the ESM
 * one @nestjs/cache-manager is typed against (see {@link CacheStore}).
 */
export function asCacheModuleStore(keyv: Keyv): CacheStore {
  return keyv as unknown as CacheStore;
}
