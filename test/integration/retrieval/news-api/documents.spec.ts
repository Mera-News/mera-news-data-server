import { ADAPTER_DOCUMENTS } from '../../../../apps/mera-server-news-api/src/modules/adapter-documents';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import {
  seedArticle,
  seedCluster,
  seedHeadlineEdition,
  seedPublisher,
  seedSource,
} from '../support/fixtures';

describe('news API documents', () => {
  let api: NewsApi;
  let variables: Record<string, Record<string, unknown>>;
  let articleId: string;

  beforeAll(async () => {
    api = await bootNewsApi();
    const publisher = await seedPublisher(api.connection, {
      country_code: 'NLD',
    });
    const source = await seedSource(api.connection, {
      country_code: 'NLD',
      newsPublisherId: publisher,
    });
    const id = await seedArticle(api.connection, { source });
    await seedCluster(api.connection, [id]);
    await seedHeadlineEdition(api.connection, 'NLD', [id]);
    articleId = String(id);
    const countryCode = 'NLD';
    variables = {
      MeraResolveTopics: {
        query: {
          topics: [],
          topHeadlines: { scopes: [{ scope: 'COUNTRY', countryCode }] },
        },
      },
      MeraHydrateArticles: { articleIds: [articleId] },
      MeraArticleById: { id: articleId },
      MeraTopHeadlinesForCountry: { countryCode, first: 3 },
      MeraArticlesForCountry: { countryCode, first: 3 },
      MeraArticlesForPublisher: {
        newsPublisherId: String(publisher),
        first: 3,
      },
      MeraArticlesForSource: {
        publicationSourceId: String(source._id),
        first: 3,
      },
      MeraRelatedArticles: { articleId, stableClusterId: null },
      MeraNewsPublishers: { countryCode, first: 3 },
      MeraAllCountries: {},
      MeraRecentArticleCount: { since: null },
    };
  });
  afterAll(() => api.close());

  it('has a variable set for every document', () => {
    expect(Object.keys(variables).sort()).toEqual(
      Object.keys(ADAPTER_DOCUMENTS).sort(),
    );
    expect(Object.keys(ADAPTER_DOCUMENTS)).toHaveLength(11);
  });

  it.each(Object.keys(ADAPTER_DOCUMENTS))(
    '%s runs without errors',
    async (name) => {
      const res = await api.gql(ADAPTER_DOCUMENTS[name], variables[name]);

      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data).toBeTruthy();
    },
  );

  it('returns usable article rows from the article documents', async () => {
    const run = async (name: string) =>
      (
        await api.gql<Record<string, any>>(
          ADAPTER_DOCUMENTS[name],
          variables[name],
        )
      ).body.data!;
    const rows: any[] = [
      (await run('MeraHydrateArticles')).articlesForTopicsByIds.articles[0],
      (await run('MeraArticleById')).articleById,
      (await run('MeraArticlesForCountry')).articlesForCountry.articles[0],
      (await run('MeraArticlesForPublisher')).articlesForPublisher.articles[0],
      (await run('MeraArticlesForSource')).articlesForPublicationSource
        .articles[0],
      (await run('MeraTopHeadlinesForCountry')).topHeadlinesForCountry
        .headlines[0]?.article,
    ];

    for (const row of rows) {
      expect(row._id).toBe(articleId);
      expect(row.article_url).toMatch(/^https:\/\/example\.test\//);
    }
  });
});
