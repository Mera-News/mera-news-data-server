import { ADAPTER_DOCUMENTS } from '../../../../apps/mera-server-news-api/src/modules/adapter-documents';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import { seedArticle, seedSource } from '../support/fixtures';

describe('news API request caps', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());
  beforeEach(() => api.resetDb());

  it('refuses 51 article ids', async () => {
    const articleIds = Array.from({ length: 51 }, (_, i) => String(i));
    const res = await api.gql(ADAPTER_DOCUMENTS.MeraHydrateArticles, {
      articleIds,
    });

    expect(res.body.errors?.[0].message).toMatch(/Too many article ids/);
  });

  it('refuses 201 topics', async () => {
    const topics = Array.from({ length: 201 }, (_, i) => ({
      text: `topic ${i}`,
    }));
    const res = await api.gql(ADAPTER_DOCUMENTS.MeraResolveTopics, {
      query: { topics },
    });

    expect(res.body.errors?.[0].message).toMatch(/Too many topics/);
  });

  it('serves one valid id unmetered', async () => {
    const source = await seedSource(api.connection);
    const id = await seedArticle(api.connection, { source });
    const res = await api.gql<{
      articlesForTopicsByIds: {
        articles: unknown[];
        dailyLimitReached: boolean;
        resetAt: string | null;
      };
    }>(ADAPTER_DOCUMENTS.MeraHydrateArticles, { articleIds: [String(id)] });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data?.articlesForTopicsByIds).toMatchObject({
      dailyLimitReached: false,
      resetAt: null,
    });
    expect(res.body.data?.articlesForTopicsByIds.articles).toHaveLength(1);
  });
});
