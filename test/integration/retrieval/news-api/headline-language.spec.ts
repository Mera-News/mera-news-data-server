import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import {
  seedArticle,
  seedHeadlineEdition,
  seedSource,
} from '../support/fixtures';

type Result = {
  articleIdsForPersona: { headlineResults: { articleIds: string[] }[] };
};

const QUERY =
  'query($l: String) { articleIdsForPersona(query: { topics: [], topHeadlines: { scopes: [{ scope: GLOBAL }] } }, language: $l) { headlineResults { articleIds } } }';

describe('For You headline stories for a reader language', () => {
  let api: NewsApi;
  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());
  beforeEach(() => api.resetDb());

  async function seed() {
    const source = await seedSource(api.connection);
    const [aEn, aFr, b, c] = [
      await seedArticle(api.connection, { source }),
      await seedArticle(api.connection, { source }),
      await seedArticle(api.connection, { source }),
      await seedArticle(api.connection, { source }),
    ];
    await seedHeadlineEdition(api.connection, 'GLOBAL', [
      {
        articleId: aEn,
        cards: [
          { articleId: aEn, lang: 'en', score: 70 },
          { articleId: aFr, lang: 'fr', score: 30 },
        ],
      },
      {
        articleId: b,
        cards: [
          { articleId: b, lang: 'en', score: 20 },
          { articleId: c, lang: 'fr', score: 80 },
        ],
      },
    ]);
    return { aEn: String(aEn), b: String(b), c: String(c) };
  }
  const ids = (res: { body: { data?: Result | null } }) =>
    res.body.data!.articleIdsForPersona.headlineResults[0].articleIds;

  it('swaps the card per language, keyed on the language, and keeps the story order', async () => {
    const { aEn, b, c } = await seed();
    // Without a language first: a cache key lacking the language would replay this.
    expect(ids(await api.gql<Result>(QUERY, {}))).toEqual([aEn, b]);
    const fr = await api.gql<Result>(QUERY, { l: 'fr' });
    expect(fr.body.errors).toBeUndefined();
    expect(ids(fr)).toEqual([aEn, c]);
  });

  it('rejects a language that is not a base tag', async () => {
    const res = await api.gql<Result>(QUERY, { l: 'english' });
    expect(res.body.errors?.[0].extensions?.code).toBe('BAD_REQUEST');
  });
});
