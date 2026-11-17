import { ARTICLE_QUOTA, type ArticleQuotaPort } from '@mera/news-core';
import { API_KEY_VERIFIER } from '../../../../apps/mera-server-news-api/src/guards/api-key.guard';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import { seedArticle, seedSource } from '../support/fixtures';

class RecordingQuota implements ArticleQuotaPort {
  reserved: { userId: string; count: number; now?: Date }[] = [];

  reserve(userId: string, count: number, now?: Date) {
    this.reserved.push({ userId, count, now });
    return Promise.resolve({
      granted: count,
      limitReached: false,
      resetAt: new Date(),
    });
  }

  incrementStoryCount() {
    return Promise.resolve();
  }
}

const HYDRATE = `query($ids: [ID!]!) {
  articlesForTopicsByIds(articleIds: $ids) { articles { _id } dailyLimitReached }
}`;

describe('news API key principal', () => {
  const quota = new RecordingQuota();
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi({
      override: (builder) =>
        builder
          .overrideProvider(API_KEY_VERIFIER)
          .useValue({
            verify: async (k?: string) => (k === 'k1' ? 'p-1' : null),
          })
          .overrideProvider(ARTICLE_QUOTA)
          .useValue(quota),
    });
  });
  afterAll(() => api.close());
  beforeEach(async () => {
    quota.reserved = [];
    await api.resetDb();
  });

  it('charges the quota to the principal the verifier named for the key', async () => {
    const source = await seedSource(api.connection);
    const id = await seedArticle(api.connection, { source });

    const res = await api.gql(HYDRATE, { ids: [String(id)] }, 'k1');

    expect(res.body.errors).toBeUndefined();
    expect(quota.reserved).toEqual([
      { userId: 'p-1', count: 1, now: expect.any(Date) },
    ]);
  });

  it('refuses a key the verifier does not know, without reserving', async () => {
    const res = await api.gql(HYDRATE, { ids: ['x'] }, 'k2');

    expect(res.body.errors?.[0].message).toBe('Invalid API key');
    expect(quota.reserved).toEqual([]);
  });
});
