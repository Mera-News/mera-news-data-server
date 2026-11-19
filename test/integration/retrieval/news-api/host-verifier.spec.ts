import { Inject, Injectable, Module, type DynamicModule } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import { NewsApiModule } from '../../../../apps/mera-server-news-api/src/app.module';
import {
  API_KEY_VERIFIER,
  type ApiKeyVerifier,
} from '../../../../apps/mera-server-news-api/src/guards/api-key.guard';
import {
  ARTICLE_QUOTA,
  type ArticleQuotaPort,
  type QuotaReservation,
} from '../../../../libs/mera-news-core/src/quota/article-quota.port';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import { seedArticle, seedSource } from '../support/fixtures';

const KEY_BOOK = 'KEY_BOOK';
const OVER_LIMIT_KEY = 'key-over-its-limit';

/** Stands in for whatever store a host application keeps its keys in. */
class KeyBook {
  readonly reserved: string[] = [];
  owner(key: string | undefined): string | null {
    return key === 'key-of-acme' ? 'acme' : null;
  }
}

@Module({
  providers: [{ provide: KEY_BOOK, useValue: new KeyBook() }],
  exports: [KEY_BOOK],
})
class KeyBookModule {}

@Injectable()
class BookVerifier implements ApiKeyVerifier {
  constructor(@Inject(KEY_BOOK) private readonly book: KeyBook) {}
  verify(presented: string | undefined): Promise<string | null> {
    if (presented === OVER_LIMIT_KEY) {
      // A GraphQLError keeps its extensions on the way out. An HttpException
      // with a status other than 400, 401, 403 or 422 would be reshaped by
      // the GraphQL layer into INTERNAL_SERVER_ERROR.
      throw new GraphQLError('Daily request limit reached', {
        extensions: { code: 'TOO_MANY_REQUESTS', retryAfterSeconds: 5 },
      });
    }
    return Promise.resolve(this.book.owner(presented));
  }
}

@Injectable()
class BookQuota implements Pick<ArticleQuotaPort, 'reserve'> {
  constructor(@Inject(KEY_BOOK) private readonly book: KeyBook) {}
  reserve(userId: string, count: number): Promise<QuotaReservation> {
    this.book.reserved.push(userId);
    return Promise.resolve({
      granted: count,
      limitReached: false,
      resetAt: new Date(),
    });
  }
}

const BY_IDS =
  'query($ids: [ID!]!) { articlesForTopicsByIds(articleIds: $ids) { articles { _id } dailyLimitReached } }';

describe('news API with a host-supplied verifier and quota', () => {
  let api: NewsApi;
  let root: DynamicModule;

  beforeAll(async () => {
    root = NewsApiModule.forRoot({
      imports: [KeyBookModule],
      apiKeyVerifier: { provide: API_KEY_VERIFIER, useClass: BookVerifier },
      articleQuota: { provide: ARTICLE_QUOTA, useClass: BookQuota },
    });
    api = await bootNewsApi({ root });
    await api.resetDb();
  });
  afterAll(() => api.close());

  it('charges the quota to the principal its verifier answered', async () => {
    const source = await seedSource(api.connection);
    const id = await seedArticle(api.connection, { source });

    const res = await api.gql<{
      articlesForTopicsByIds: { articles: { _id: string }[] };
    }>(BY_IDS, { ids: [String(id)] }, 'key-of-acme');

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.articlesForTopicsByIds.articles).toHaveLength(1);
    expect(api.app.get<KeyBook>(KEY_BOOK).reserved).toEqual(['acme']);
  });

  it('refuses an unknown key with HTTP 200 and UNAUTHENTICATED', async () => {
    const res = await api.gql(BY_IDS, { ids: [] }, 'not-a-key');

    expect(res.status).toBe(200);
    expect(res.body.data ?? null).toBeNull();
    expect(res.body.errors?.[0].message).toBe('Invalid API key');
    expect(res.body.errors?.[0].extensions?.code).toBe('UNAUTHENTICATED');
  });

  it("passes the verifier's own refusal on unchanged, with HTTP 200", async () => {
    const res = await api.gql(BY_IDS, { ids: [] }, OVER_LIMIT_KEY);

    expect(res.status).toBe(200);
    expect(res.body.data ?? null).toBeNull();
    expect(res.body.errors?.[0].message).toBe('Daily request limit reached');
    expect(res.body.errors?.[0].extensions).toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      retryAfterSeconds: 5,
    });
  });
});

describe('news API forRoot with no options', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi({ root: NewsApiModule.forRoot() });
  });
  afterAll(() => api.close());

  it('accepts the configured key and refuses a wrong one, as today', async () => {
    const ok = await api.gql<{ allCountries: string[] }>('{ allCountries }');
    const wrong = await api.gql('{ allCountries }', {}, 'wrong-key');

    expect(ok.body.errors).toBeUndefined();
    expect(wrong.body.errors?.[0].message).toBe('Invalid API key');
  });
});
