import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { MongooseModule } from '@nestjs/mongoose';
import { ThrottlerModule } from '@nestjs/throttler';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import {
  HealthModule,
  STORY_NAMES_GENERATOR,
  StructuredLoggerModule,
  UnconfiguredStoryNamesGenerator,
  asCacheModuleStore,
  buildKeyvRedisStore,
  type CacheStore,
  normalizeCacheNamespace,
} from '@mera/shared';
import { readBool, readText } from '@mera/shared/config/env-choice';
import { ModelsNewsModule } from '@mera/models/models/models-news.module';
import {
  ARTICLE_QUOTA,
  EmbeddingProviderModule,
  MeraNewsCoreModule,
  NoopArticleQuota,
} from '@mera/news-core';
import {
  API_KEY_VERIFIER,
  ApiKeyGuard,
  EnvApiKeyVerifier,
  OpenApiKeyVerifier,
} from './guards/api-key.guard';
import { GqlThrottlerGuard } from './guards/gql-throttler.guard';
import {
  InternalNewsPublisherFieldResolver,
  InternalNewsResolver,
} from './modules/internal-news.resolver';

const DEFAULT_CACHE_TTL_MS = 3_600_000;
const DEFAULT_OPEN_RATE_LIMIT = 60;

/** `NEWS_API_OPEN`: serve without a key. `true` or `false` only. */
export function newsApiOpen(config: ConfigService): boolean {
  return readBool(config, 'NEWS_API_OPEN', false);
}

/** `NEWS_API_OPEN_RATE_LIMIT`: requests a minute per address in open mode. */
export function openRateLimit(config: ConfigService): number {
  const text = readText(config, 'NEWS_API_OPEN_RATE_LIMIT');
  if (text === '') return DEFAULT_OPEN_RATE_LIMIT;
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `NEWS_API_OPEN_RATE_LIMIT="${text}" must be a positive whole number`,
    );
  }
  return n;
}

/**
 * `mera-server-news-api` — the INTERNAL news surface.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS IS A SEPARATE SERVICE
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * A news client reaches this backend through a `NewsDataProvider` port whose
 * outbound header set is frozen and test-enforced: `x-api-key`, an id-token,
 * a constant user-agent, a random request id. It structurally CANNOT present a
 * user session.
 *
 * The app-facing API cannot serve that caller. Every one of its operations goes
 * through `AuthMiddleware`, which resolves a better-auth session and throws
 * `UnauthorizedException` when there is none, and its feed queries additionally
 * carry `SubscriptionGuard` + `@CurrentUser`. A credential-less service call
 * would 401 — and the adapter degrades a 401 into an empty result, so the
 * symptom would be an empty feed with only an error count in the log.
 *
 * Bolting an API-key bypass onto that endpoint was the cheaper option and was
 * rejected: one leaked key would then also reach `userPersonaByUserId`,
 * `userBilling` and `unblockRequestStatus` on the same path. Two trust
 * boundaries, two services.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE INVARIANT THIS FILE EXISTS TO HOLD
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ONLY `ModelsNewsModule` is registered — the anonymous news schemas. Not
 * `MeraModelsModule`, which pulls in `ModelsUsersModule` alongside it.
 *
 * The COUNT is deliberately not written here. It is 14 today and it was 13
 * when this comment was first written; `models-split.spec.ts` asserts the
 * number and is the only place that should, because a number repeated in prose
 * goes stale silently while a number in a test goes red.
 *
 * That is not tidiness. A Mongoose model registered against a credential that
 * cannot read its collection fails at QUERY time, not at boot, so simply not
 * registering the user schemas is the real fix: this service can be given a
 * database credential scoped to the news collections and nothing in it will
 * even be able to name a user collection.
 *
 * Consequently: no `AuthMiddleware`, no `SubscriptionGuard`, no
 * `@CurrentUser`, no mutations, and `ARTICLE_QUOTA` bound to
 * `NoopArticleQuota` — metering needs a user, and there isn't one.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env', cache: true }),
    StructuredLoggerModule.forRoot('mera-server-news-api'),
    // Same shape as the app-facing API's cache so the topic-classification
    // cache keys live in the same namespace and both services get hits on work
    // the other already paid Jina for.
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: (
        configService: ConfigService,
      ): { stores?: CacheStore[]; ttl: number } => {
        if (configService.get<string>('CACHE_STORE', 'memory') === 'redis') {
          return {
            stores: [
              asCacheModuleStore(
                buildKeyvRedisStore({
                  url: configService.get<string>('REDIS_URL'),
                  namespace: normalizeCacheNamespace(
                    configService.get<string>('CACHE_KEY_PREFIX', 'v3:'),
                  ),
                  ttlMs: DEFAULT_CACHE_TTL_MS,
                  logContext: 'NewsApiCache',
                }),
              ),
            ],
            ttl: DEFAULT_CACHE_TTL_MS,
          };
        }
        return { ttl: DEFAULT_CACHE_TTL_MS };
      },
      inject: [ConfigService],
    }),
    MongooseModule.forRootAsync({
      useFactory: (configService: ConfigService) => {
        const uri = configService.get<string>('MONGODB_URI');
        if (!uri) {
          throw new Error('MONGODB_URI environment variable is not defined');
        }
        return {
          uri,
          maxPoolSize: configService.get<number>('MONGODB_MAX_POOL_SIZE', 5),
          minPoolSize: 0,
          maxIdleTimeMS: 60_000,
          serverSelectionTimeoutMS: 10_000,
          readPreference: 'primary',
        };
      },
      inject: [ConfigService],
    }),
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      useFactory: (configService: ConfigService) => ({
        // Never in production: this schema is an internal contract, and an
        // exposed explorer is a map of it for anyone who reaches the URL.
        graphiql: configService.get<string>('NODE_ENV') !== 'production',
        autoSchemaFile:
          configService.get<string>('NODE_ENV') === 'production'
            ? true
            : join(process.cwd(), 'apps/mera-server-news-api/src/schema.gql'),
        sortSchema: true,
        // ApiKeyGuard reads `req` from here. Without this the guard cannot see
        // the headers on a GraphQL request and rejects everything.
        context: ({ req, res }: { req: unknown; res: unknown }) => ({
          req,
          res,
        }),
      }),
      inject: [ConfigService],
    }),
    // Registered always, active only in open mode (see the verifier below).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const open = newsApiOpen(config);
        return {
          throttlers: [{ ttl: 60_000, limit: openRateLimit(config) }],
          skipIf: () => !open,
        };
      },
    }),
    // NEWS SCHEMAS ONLY. See the class comment — do not swap this for
    // `MeraModelsModule`.
    ModelsNewsModule,
    EmbeddingProviderModule,
    // The whole news pipeline, composed with the UNMETERED quota binding.
    // There is no user to charge on this surface; the caller enforces its own
    // users' quotas on its own side. `forRoot` takes the binding rather than
    // defaulting it, so a service that forgot to state which side of that line
    // it sits on fails at boot instead of silently charging nobody.
    // Never generates story names (this service has no Gemini env): stored names
    // still apply to strict topics, and a row without them is unfiltered.
    MeraNewsCoreModule.forRoot({
      quota: { provide: ARTICLE_QUOTA, useClass: NoopArticleQuota },
      storyNames: {
        provide: STORY_NAMES_GENERATOR,
        useClass: UnconfiguredStoryNamesGenerator,
      },
    }),
    HealthModule.forRoot({
      mongo: true,
      redis: process.env.CACHE_STORE === 'redis',
    }),
  ],
  providers: [
    InternalNewsResolver,
    InternalNewsPublisherFieldResolver,
    // Global, so a new resolver is protected by default rather than by
    // remembering to decorate it. Opt out with `@SkipApiKey()`.
    // Open mode is for one reader's own install: one shared principal, so
    // the per-IP limit is the only per-caller bound.
    {
      provide: API_KEY_VERIFIER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        newsApiOpen(config)
          ? new OpenApiKeyVerifier()
          : new EnvApiKeyVerifier(config),
    },
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: GqlThrottlerGuard },
  ],
})
export class AppModule {}
