import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_JOB_OPTIONS,
  asCacheModuleStore,
  buildKeyvRedisStore,
  type CacheStore,
  normalizeCacheNamespace,
} from '@mera/shared';

/**
 * Redis connection wiring for the async service.
 *
 * The async service talks to TWO logical Redis roles, which can live on one
 * instance or on two:
 *
 *   - BullMQ queues/flows  → `news-bullmq-redis` (noeviction).  Reached via
 *     `REDIS_URL`, namespaced by `BULLMQ_PREFIX` (default `bull` — i.e. exactly
 *     BullMQ's own default, so this is a no-op until a deployment sets it).
 *   - Volatile TTL'd data cache (RSS-dedup fingerprints, pub-source-info) →
 *     `news-persistent-redis` (volatile-ttl).  Reached via
 *     `PERSISTENT_REDIS_URL`, falling back to `REDIS_URL` when unset (no-op
 *     default), namespaced by `CACHE_KEY_PREFIX`.
 *
 * Two deployments that share these instances are isolated purely by these key
 * prefixes, so the prefixes are load-bearing: a prefix collision would let one
 * read/overwrite the other's keys (e.g. silently dropping articles the other
 * already ingested via the RSS-dedup fingerprint cache).
 */

export const DEFAULT_BULLMQ_PREFIX = 'bull';
export const CACHE_TTL_MS = 3600000; // 1 hour default TTL in milliseconds

/**
 * The BullMQ key prefix for this service. Defaults to `bull` (BullMQ's own
 * default), so unset === current behavior. A second deployment on the same Redis sets its own, such as `bull-alt`.
 */
export function resolveBullmqPrefix(configService: ConfigService): string {
  return configService.get<string>('BULLMQ_PREFIX', DEFAULT_BULLMQ_PREFIX);
}

/**
 * Root config for `BullModule.forRootAsync`. The `prefix` set here propagates
 * to every `registerQueue()` and `registerFlowProducer()` in the module (they
 * inherit the shared root config unless they override it), and on through to
 * the workers/QueueEvents the explorer creates — verified against
 * @nestjs/bullmq's `createQueueOptionProviders` / `createFlowProducerOptionProviders`
 * (shared config spread first, per-registration options spread over it) and
 * `bull.explorer` (worker reads `queueOpts.prefix`).
 */
export function buildBullRootConfig(configService: ConfigService) {
  return {
    connection: {
      url: configService.get<string>('REDIS_URL'),
    },
    prefix: resolveBullmqPrefix(configService),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  };
}

/**
 * Normalize a cache key prefix into a Keyv namespace. Re-exported from
 * `@mera/shared` (see {@link normalizeCacheNamespace}); kept under this name for
 * back-compat. An empty/unset prefix means "no prefix"; any trailing colon(s)
 * are stripped because Keyv appends exactly one as its separator, so both `alt`
 * and `alt:` yield the on-wire key `alt:<key>`.
 */
export const normalizeCacheKeyPrefix = normalizeCacheNamespace;

/**
 * Options for `CacheModule.registerAsync`. Reads `PERSISTENT_REDIS_URL` first,
 * falling back to `REDIS_URL`; builds a real `@keyv/redis`-backed `stores: []`
 * (cache-manager v7 ignores the legacy singular `store`), namespaced by
 * `CACHE_KEY_PREFIX` so keys are actually prefixed on the wire.
 */
export function buildCacheModuleOptions(configService: ConfigService): {
  stores: CacheStore[];
  ttl: number;
} {
  const url =
    configService.get<string>('PERSISTENT_REDIS_URL') ??
    configService.get<string>('REDIS_URL');
  const namespace = normalizeCacheKeyPrefix(
    configService.get<string>('CACHE_KEY_PREFIX'),
  );
  return {
    stores: [
      asCacheModuleStore(
        buildKeyvRedisStore({
          url,
          namespace,
          ttlMs: CACHE_TTL_MS,
          logContext: 'AsyncCache',
        }),
      ),
    ],
    ttl: CACHE_TTL_MS,
  };
}
