import { INestApplication, type DynamicModule } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { SEARCH_INDEX_ADMIN } from '@mera/models/search-index/search-index-admin.port';
import { InMemorySearchIndexAdmin } from '../../../harness/atlas-search-fake';
import { AppModule } from '../../../../apps/mera-server-news-api/src/app.module';

/** The key the booted news API accepts unless a test overrides it. */
export const TEST_API_KEY = 'news-api-test-key';

export interface GqlResponse<T> {
  status: number;
  body: {
    data?: T | null;
    errors?: { message: string; extensions?: Record<string, unknown> }[];
  };
}

export interface NewsApi {
  app: INestApplication;
  connection: Connection;
  /** The search index commands the app was booted with. */
  searchIndexAdmin: InMemorySearchIndexAdmin;
  /** A supertest agent on the app, for non-GraphQL routes such as /health. */
  http(): ReturnType<typeof request>;
  /** POSTs one GraphQL operation with `x-api-key` (omitted when `apiKey` is null). */
  gql<T>(
    query: string,
    variables?: Record<string, unknown>,
    apiKey?: string | null,
  ): Promise<GqlResponse<T>>;
  /** Deletes every document in every collection of this worker's database. */
  resetDb(): Promise<void>;
  close(): Promise<void>;
}

export interface BootNewsApiOptions {
  /**
   * Env values for this boot, restored on close. Use '' for "unset": deleting
   * a key would let a `.env` file fill it back in.
   */
  env?: Record<string, string>;
  /** Provider overrides, e.g. `API_KEY_VERIFIER` or `ARTICLE_QUOTA`. */
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  /** The root module to boot instead of `AppModule`, e.g. `NewsApiModule.forRoot({...})`. */
  root?: DynamicModule;
  /** Stands in for the cluster's search index commands. Default: both indexes built and ready. */
  searchIndexAdmin?: InMemorySearchIndexAdmin;
}

/**
 * Boots the real news API app on the harness: the per-worker in-memory Mongo
 * database, the fake embedding provider, the in-process cache. The
 * vector-search fake is NOT installed here; a suite that reaches
 * `$vectorSearch` installs it itself.
 */
export async function bootNewsApi(
  options: BootNewsApiOptions = {},
): Promise<NewsApi> {
  const env = {
    MERA_NEWS_API_KEY: TEST_API_KEY,
    CACHE_STORE: 'memory',
    ...options.env,
  };
  const saved = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  const searchIndexAdmin =
    options.searchIndexAdmin ?? InMemorySearchIndexAdmin.withReadyIndexes();

  try {
    let builder = Test.createTestingModule({
      imports: [options.root ?? AppModule],
    })
      .overrideProvider(SEARCH_INDEX_ADMIN)
      .useValue(searchIndexAdmin);
    if (options.override) builder = options.override(builder);
    const moduleRef = await builder.compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    const connection = app.get<Connection>(getConnectionToken());
    const server = app.getHttpServer() as Parameters<typeof request>[0];
    const http = () => request(server);

    const gql = async <T>(
      query: string,
      variables: Record<string, unknown> = {},
      apiKey: string | null = TEST_API_KEY,
    ): Promise<GqlResponse<T>> => {
      let req = http().post('/graphql');
      if (apiKey !== null) req = req.set('x-api-key', apiKey);
      const res = await req.send({ query, variables });
      return { status: res.status, body: res.body as GqlResponse<T>['body'] };
    };

    const resetDb = async () => {
      const collections = await connection.db!.collections();
      await Promise.all(collections.map((c) => c.deleteMany({})));
    };

    const close = async () => {
      await app.close();
      restore(saved);
    };

    return { app, connection, searchIndexAdmin, http, gql, resetDb, close };
  } catch (error) {
    restore(saved);
    throw error;
  }
}

function restore(saved: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
