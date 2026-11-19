import {
  type DynamicModule,
  Module,
  type ModuleMetadata,
  type Provider,
} from '@nestjs/common';
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
import { ModelsNewsModule } from '@mera/models/models/models-news.module';
import {
  ARTICLE_QUOTA,
  CanonicalTopicsService,
  EmbeddingProviderModule,
  MeraNewsCoreModule,
  NewsSearchService,
  NoopArticleQuota,
  PlaceModule,
  ServerStatusService,
  WorldHeadlinesService,
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
import { newsApiOpen, openRateLimit } from './open-mode';
import { CanonicalTopicsResolver } from './modules/canonical-topics.resolver';
import { NewsClusterArticlesResolver } from './modules/news-cluster-articles.resolver';
import { NewsSearchResolver } from './modules/news-search.resolver';
import { WorldHeadlinesResolver } from './modules/world-headlines.resolver';
import { PublicationProfileService } from '@mera/news-core/publication-profile/publication-profile.service';
import {
  ArticleSourceUriResolver,
  PublicSourceResolver,
} from '@mera/news-core/source-url/source-url.resolvers';
import {
  keepQueryLimitCode,
  MAX_QUERY_FIELDS,
  maxQueryDepth,
  queryLimitsRule,
} from './query-limits';

const DEFAULT_CACHE_TTL_MS = 3_600_000;

export interface NewsApiModuleOptions {
  /** Modules that a supplied verifier or quota needs for its own dependencies. */
  imports?: ModuleMetadata['imports'];
  /**
   * Binds `API_KEY_VERIFIER`. Default: the key in `MERA_NEWS_API_KEY`, or
   * `OpenApiKeyVerifier` in open mode. A null answer is refused as "Invalid API
   * key" (`UNAUTHENTICATED`). To refuse differently, throw a `GraphQLError`
   * with your own `extensions.code`: it reaches the caller unchanged. An
   * `HttpException` is reshaped by the GraphQL layer, and any status other than
   * 400, 401, 403 or 422 arrives as `INTERNAL_SERVER_ERROR`. Either way the
   * HTTP status is 200.
   */
  apiKeyVerifier?: Provider;
  /** Binds `ARTICLE_QUOTA`. Default: `NoopArticleQuota`, which charges nothing. */
  articleQuota?: Provider;
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
 * `@CurrentUser`, no mutations, and by default `ARTICLE_QUOTA` bound to
 * `NoopArticleQuota` — metering needs a user, and there isn't one.
 *
 * A host application may supply its own verifier and quota through
 * `forRoot`, with the modules they depend on. With no options the module is
 * exactly what this repository deploys (`AppModule`).
 */
@Module({})
export class NewsApiModule {
  static forRoot(options: NewsApiModuleOptions = {}): DynamicModule {
    return {
      module: NewsApiModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env',
          cache: true,
        }),
        StructuredLoggerModule.forRoot('mera-server-news-api'),
        // Same shape as the app-facing API's cache so the topic-classification
        // cache keys live in the same namespace and both services get hits on work
        // the other already paid Jina for.
        CacheModule.registerAsync({
          isGlobal: true,
          useFactory: (
            configService: ConfigService,
          ): { stores?: CacheStore[]; ttl: number } => {
            if (
              configService.get<string>('CACHE_STORE', 'memory') === 'redis'
            ) {
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
              throw new Error(
                'MONGODB_URI environment variable is not defined',
              );
            }
            return {
              uri,
              maxPoolSize: configService.get<number>(
                'MONGODB_MAX_POOL_SIZE',
                5,
              ),
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
                : join(
                    process.cwd(),
                    'apps/mera-server-news-api/src/schema.gql',
                  ),
            sortSchema: true,
            // The schema is public (it is committed in this repo), and a client
            // learns what a server offers by introspection, so it stays on.
            introspection: true,
            // Refused before any resolver runs, whatever the caller's key.
            validationRules: [
              queryLimitsRule(maxQueryDepth(configService), MAX_QUERY_FIELDS),
            ],
            formatError: keepQueryLimitCode,
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
        // Place reference data: a model the news schemas do not carry.
        PlaceModule,
        // The whole news pipeline, composed with the UNMETERED quota binding.
        // There is no user to charge on this surface; the caller enforces its own
        // users' quotas on its own side. `forRoot` takes the binding rather than
        // defaulting it, so a service that forgot to state which side of that line
        // it sits on fails at boot instead of silently charging nobody.
        // Never generates story names (this service has no Gemini env): stored names
        // still apply to strict topics, and a row without them is unfiltered.
        MeraNewsCoreModule.forRoot({
          quota: options.articleQuota ?? {
            provide: ARTICLE_QUOTA,
            useClass: NoopArticleQuota,
          },
          imports: options.imports,
          storyNames: {
            provide: STORY_NAMES_GENERATOR,
            useClass: UnconfiguredStoryNamesGenerator,
          },
        }),
        HealthModule.forRoot({
          mongo: true,
          redis: process.env.CACHE_STORE === 'redis',
        }),
        ...(options.imports ?? []),
      ],
      providers: [
        InternalNewsResolver,
        InternalNewsPublisherFieldResolver,
        PublicSourceResolver,
        ArticleSourceUriResolver,
        NewsClusterArticlesResolver,
        WorldHeadlinesResolver,
        WorldHeadlinesService,
        NewsSearchResolver,
        NewsSearchService,
        PublicationProfileService,
        ServerStatusService,
        CanonicalTopicsResolver,
        CanonicalTopicsService,
        // Global, so a new resolver is protected by default rather than by
        // remembering to decorate it. Opt out with `@SkipApiKey()`.
        // Open mode is for one reader's own install: one shared principal, so
        // the per-IP limit is the only per-caller bound.
        options.apiKeyVerifier ?? {
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
    };
  }
}

/** The news API as this repository runs it: every default. */
@Module({ imports: [NewsApiModule.forRoot()] })
export class AppModule {}
