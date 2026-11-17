import { Global, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ArticleCacheService, normalizeCacheNamespace } from '@mera/shared';

/** 24h leak backstop — the projector normally DELetes keys at projection time. */
const ARTICLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Composition root for the ID-array pipeline's Redis scratchpad
 * ({@link ArticleCacheService}).
 *
 * Connects to the SAME shared `news-persistent-redis` instance the fingerprint
 * cache uses (env `PERSISTENT_REDIS_URL`, fallback `REDIS_URL`) and namespaces
 * keys by `CACHE_KEY_PREFIX` (staging `stg:`) exactly like `redis-config.ts`, so
 * staging and prod stay isolated on the shared instance. No new infra instance
 * and no `CACHE_REDIS_URL`.
 */
@Global()
@Module({
  providers: [
    {
      provide: ArticleCacheService,
      useFactory: (config: ConfigService) => {
        const url =
          config.get<string>('PERSISTENT_REDIS_URL') ??
          config.get<string>('REDIS_URL');
        const namespace = normalizeCacheNamespace(
          config.get<string>('CACHE_KEY_PREFIX'),
        );
        return new ArticleCacheService({
          url,
          namespace,
          ttlMs: ARTICLE_CACHE_TTL_MS,
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: [ArticleCacheService],
})
export class ArticleCacheModule implements OnModuleDestroy {
  constructor(private readonly cache: ArticleCacheService) {}

  async onModuleDestroy(): Promise<void> {
    await this.cache.close();
  }
}
