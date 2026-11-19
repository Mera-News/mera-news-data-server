import { CLIENT_DOCUMENTS } from '../../../../apps/mera-server-news-api/src/modules/client-documents';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import { seedTopic } from '../support/fixtures';

type Topics = {
  canonicalTopics: {
    id: string;
    path: string;
    label: string;
    level: number;
    parentId: string | null;
  }[];
};

const op = CLIENT_DOCUMENTS.GetCanonicalTopics;

async function seedTree(api: NewsApi) {
  for (const [path, level] of [
    ['/Sports', 1],
    ['/Finance', 1],
    ['/Finance/Banking', 2],
  ] as const) {
    await seedTopic(api.connection, `cat:${path}`, {
      is_canonical: true,
      canonical_path: path,
      canonical_level: level,
    });
  }
  // A reader's own topic text lives in the same collection and must never be listed.
  await seedTopic(api.connection, 'local elections in my town');
}

describe('canonical topics', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi();
    await api.resetDb();
  });
  afterAll(() => api.close());

  it('serves the tree as soon as it is seeded, even after an empty answer', async () => {
    const before = await api.gql<Topics>(op, {});
    expect(before.body.errors).toBeUndefined();
    expect(before.body.data!.canonicalTopics).toEqual([]);

    await seedTree(api);
    const res = await api.gql<Topics>(op, {});

    expect(res.body.errors).toBeUndefined();
    const topics = res.body.data!.canonicalTopics;
    expect(topics.map((t) => [t.path, t.level, t.parentId])).toEqual([
      ['/Finance', 1, null],
      ['/Finance/Banking', 2, null],
      ['/Sports', 1, null],
    ]);
    expect(topics.every((t) => /^[0-9a-f]{24}$/.test(t.id))).toBe(true);
    expect(topics.map((t) => t.label)).toEqual([
      'Finance',
      'Banking',
      'Sports',
    ]);
  });

  it('answers one level when asked', async () => {
    const res = await api.gql<Topics>(op, { level: 2 });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.canonicalTopics.map((t) => t.path)).toEqual([
      '/Finance/Banking',
    ]);
  });

  it('refuses a caller with no key', async () => {
    const res = await api.gql<Topics>(op, {}, null);

    expect(res.body.errors?.[0].message).toBe('Invalid API key');
    expect(res.body.data ?? null).toBeNull();
  });
});

describe('canonical topics in open mode', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi({
      env: { MERA_NEWS_API_KEY: '', NEWS_API_OPEN: 'true' },
    });
    await api.resetDb();
    await seedTree(api);
  });
  afterAll(() => api.close());

  it('serves the tree with no key', async () => {
    const res = await api.gql<Topics>(op, {}, null);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.canonicalTopics).toHaveLength(3);
  });
});
