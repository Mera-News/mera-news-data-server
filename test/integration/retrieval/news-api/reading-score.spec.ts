import { seedArticle, seedPublisher, seedSource } from '../support/fixtures';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';

type Scored = { articles: { _id: string; readingScore: number | null }[] };

describe('reading score', () => {
  let api: NewsApi;
  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());
  beforeEach(() => api.resetDb());

  async function seed() {
    const p1 = await seedPublisher(api.connection, { readingScore: 92 });
    const p2 = await seedPublisher(api.connection);
    const s1 = await seedSource(api.connection, { newsPublisherId: p1 });
    const s2 = await seedSource(api.connection, { newsPublisherId: p2 });
    const s3 = await seedSource(api.connection);
    const ids = [
      await seedArticle(api.connection, { source: s1 }),
      await seedArticle(api.connection, { source: s2 }),
      await seedArticle(api.connection, { source: s3 }),
    ].map(String);
    return { p1, p2, ids };
  }

  it('is served on article hydration', async () => {
    const { ids } = await seed();
    const res = await api.gql<{ articlesForTopicsByIds: Scored }>(
      'query($ids: [ID!]!) { articlesForTopicsByIds(articleIds: $ids) { articles { _id readingScore } } }',
      { ids },
    );
    expect(res.body.errors).toBeUndefined();
    const by = new Map(
      res.body.data!.articlesForTopicsByIds.articles.map((a) => [
        a._id,
        a.readingScore,
      ]),
    );
    expect(ids.map((id) => by.get(id))).toEqual([92, null, null]);
  });

  it('is served on story hydration', async () => {
    const { ids } = await seed();
    const res = await api.gql<{ articlesForStories: Scored }>(
      'query($ids: [ID!]!) { articlesForStories(articleIds: $ids) { articles { _id readingScore } } }',
      { ids },
    );
    expect(res.body.errors).toBeUndefined();
    const by = new Map(
      res.body.data!.articlesForStories.articles.map((a) => [
        a._id,
        a.readingScore,
      ]),
    );
    expect(ids.map((id) => by.get(id))).toEqual([92, null, null]);
  });

  const PROFILE =
    'query($id: ID) { publicationProfile(newsPublisherId: $id) { readingScore } }';

  it('is served on the publication profile', async () => {
    const { p1, p2 } = await seed();
    const one = await api.gql<{
      publicationProfile: { readingScore: number | null };
    }>(PROFILE, { id: String(p1) });
    const two = await api.gql<{
      publicationProfile: { readingScore: number | null };
    }>(PROFILE, { id: String(p2) });
    expect(one.body.data!.publicationProfile.readingScore).toBe(92);
    expect(two.body.data!.publicationProfile.readingScore).toBeNull();
  });

  it('never passes a non-number through', async () => {
    const p = await seedPublisher(api.connection, { readingScore: '92' });
    await seedSource(api.connection, { newsPublisherId: p });
    const res = await api.gql<{
      publicationProfile: { readingScore: number | null };
    }>(PROFILE, { id: String(p) });
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.publicationProfile.readingScore).toBeNull();
  });
});
