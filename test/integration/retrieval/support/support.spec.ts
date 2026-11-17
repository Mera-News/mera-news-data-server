import { FakeEmbeddingProvider, topicEmbedText } from '@mera/news-core';
import { bootNewsApi, type NewsApi } from './boot-news-api';
import {
  seedArticle,
  seedHeadlineEdition,
  seedSource,
  vectorWithScore,
} from './fixtures';

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  a.forEach((x, i) => {
    dot += x * b[i];
    na += x * x;
    nb += b[i] * b[i];
  });
  return dot / Math.sqrt(na * nb);
};

describe('retrieval support: vectorWithScore', () => {
  it.each([1, 0.9, 0.79, 0.77, 0.5])(
    'scores %p against the topic query vector',
    (score) => {
      const query = FakeEmbeddingProvider.vectorFor(
        topicEmbedText('Example topic'),
      );
      const v = vectorWithScore('Example topic', score);
      expect((1 + cosine(query, v)) / 2).toBeCloseTo(score, 6);
    },
  );
});

describe('retrieval support: bootNewsApi', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());
  beforeEach(() => api.resetDb());

  it('serves /health without a key', async () => {
    await api.http().get('/health').expect(200);
  });

  it('answers a keyed query from the seeded database', async () => {
    const source = await seedSource(api.connection, { country_code: 'NLD' });
    const id = await seedArticle(api.connection, { source });

    const countries = await api.gql<{ allCountries: string[] }>(
      '{ allCountries }',
    );
    expect(countries.body.errors).toBeUndefined();
    expect(countries.body.data?.allCountries).toContain('NLD');

    const hydrated = await api.gql<{
      articlesForTopicsByIds: { articles: { _id: string }[] };
    }>(
      'query($ids: [ID!]!) { articlesForTopicsByIds(articleIds: $ids) { articles { _id } } }',
      { ids: [id.toString()] },
    );
    expect(hydrated.body.errors).toBeUndefined();
    expect(hydrated.body.data?.articlesForTopicsByIds.articles).toEqual([
      { _id: id.toString() },
    ]);
  });

  it('serves a seeded GLOBAL edition to a headlines-only persona query', async () => {
    const source = await seedSource(api.connection);
    const ids = [
      await seedArticle(api.connection, { source }),
      await seedArticle(api.connection, { source }),
    ];
    await seedHeadlineEdition(api.connection, 'GLOBAL', ids);

    const res = await api.gql<{
      articleIdsForPersona: { headlineResults: { articleIds: string[] }[] };
    }>(
      `query($q: PersonaQueryInput!) {
        articleIdsForPersona(query: $q) { headlineResults { articleIds } }
      }`,
      { q: { topics: [], topHeadlines: { scopes: [{ scope: 'GLOBAL' }] } } },
    );
    expect(res.body.errors).toBeUndefined();
    expect(
      res.body.data?.articleIdsForPersona.headlineResults[0].articleIds,
    ).toEqual(ids.map(String));
  });
});
