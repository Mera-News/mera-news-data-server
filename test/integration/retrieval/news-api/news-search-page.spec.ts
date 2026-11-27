import { encodeSearchCursor } from '@mera/news-core';
import { installAtlasSearchFake } from '../../../harness/atlas-search-fake';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import {
  searchVectorWithScore,
  seedArticle,
  seedSource,
  type SeededSource,
} from '../support/fixtures';

type Page = {
  searchNewsPage: { hits: { _id: string }[]; nextCursor: string | null };
};

const PAGE =
  'query($q: String!, $limit: Int, $after: String) { searchNewsPage(query: $q, limit: $limit, after: $after) { hits { _id } nextCursor } }';

const QUERY = 'harbour tram line';

describe('searchNewsPage', () => {
  jest.setTimeout(60_000);
  let api: NewsApi;
  let fake: ReturnType<typeof installAtlasSearchFake>;
  let source: SeededSource;

  beforeAll(async () => {
    fake = installAtlasSearchFake();
    api = await bootNewsApi({ env: { SEARCH_CACHE_SECRET: 'page-secret' } });
  });
  afterAll(async () => {
    fake.uninstall();
    await api.close();
  });
  beforeEach(async () => {
    await api.resetDb();
    source = await seedSource(api.connection);
  });

  const page = (variables: Record<string, unknown>) =>
    api.gql<Page>(PAGE, { q: QUERY, ...variables });

  /** `count` matches, best first, every score above the search floor. */
  async function seedMatches(count: number) {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const score = 0.99 - (0.2 * i) / count;
      ids.push(
        String(
          await seedArticle(api.connection, {
            source,
            vector: searchVectorWithScore(QUERY, score),
          }),
        ),
      );
    }
    return ids;
  }

  it('walks every hit once, best first, and ends with a null cursor', async () => {
    const ids = await seedMatches(25);
    const seen: string[] = [];
    let after: string | null = null;
    for (let calls = 0; calls < 10; calls++) {
      const res = await page({ limit: 10, after });
      expect(res.body.errors).toBeUndefined();
      const { hits, nextCursor } = res.body.data!.searchNewsPage;
      seen.push(...hits.map((h) => h._id));
      after = nextCursor;
      if (!after) break;
    }
    expect(seen).toEqual(ids);
  });

  it('serves up to 100 hits a page while searchNews stays at 25', async () => {
    await seedMatches(110);
    const res = await page({ limit: 500 });
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.searchNewsPage.hits).toHaveLength(100);
    expect(res.body.data!.searchNewsPage.nextCursor).not.toBeNull();

    const bare = await api.gql<{ searchNews: unknown[] }>(
      'query($q: String!) { searchNews(query: $q, limit: 100) { _id } }',
      { q: QUERY },
    );
    expect(bare.body.data!.searchNews).toHaveLength(25);
  });

  it('keeps the window of the first page, so a newer article never shifts later pages', async () => {
    const ids = await seedMatches(3);
    const first = await page({ limit: 1 });
    // Scores 1, above every seeded one: unbounded, it would take the first slot.
    await seedArticle(api.connection, {
      source,
      createdAt: new Date(Date.now() + 1000),
      vector: searchVectorWithScore(QUERY, 1),
    });
    const second = await page({
      limit: 5,
      after: first.body.data!.searchNewsPage.nextCursor,
    });
    expect(second.body.errors).toBeUndefined();
    expect(second.body.data!.searchNewsPage.hits.map((h) => h._id)).toEqual(
      ids.slice(1),
    );
  });

  it('reads 2500 hits deep within the ANN candidate limit', async () => {
    await seedMatches(3);
    const now = new Date();
    const after = encodeSearchCursor({
      asOf: now,
      from: new Date(now.getTime() - 48 * 3600_000),
      offset: 2400,
    });
    const res = await page({ limit: 100, after });
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.searchNewsPage).toEqual({
      hits: [],
      nextCursor: null,
    });
  });

  it('answers an empty last page at 2500 deep', async () => {
    await seedMatches(3);
    const now = new Date();
    const res = await page({
      after: encodeSearchCursor({ asOf: now, from: now, offset: 2500 }),
    });
    expect(res.body.data!.searchNewsPage).toEqual({
      hits: [],
      nextCursor: null,
    });
  });

  it.each([
    ['text that is not base64 JSON', 'not a cursor'],
    [
      'a negative offset',
      Buffer.from(
        JSON.stringify({ asOf: '2026-01-01', from: '2026-01-01', offset: -1 }),
      ).toString('base64'),
    ],
    [
      'no window',
      Buffer.from(JSON.stringify({ offset: 10 })).toString('base64'),
    ],
    [
      'dated in the future',
      encodeSearchCursor({
        asOf: new Date(Date.now() + 3600_000),
        from: new Date(Date.now() + 3600_000 - 48 * 3600_000),
        offset: 0,
      }),
    ],
    [
      'reaching back past the 48h window',
      encodeSearchCursor({
        asOf: new Date(),
        from: new Date(Date.now() - 400 * 3600_000),
        offset: 0,
      }),
    ],
    [
      'a window that starts after it ends',
      encodeSearchCursor({
        asOf: new Date(Date.now() - 3600_000),
        from: new Date(),
        offset: 0,
      }),
    ],
  ])('refuses a cursor that is %s', async (_, after) => {
    const res = await page({ after });
    expect(res.body.errors?.[0].message).toBe('after is not a valid cursor');
    expect(res.body.errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('accepts a cursor a few minutes ahead of this clock', async () => {
    const asOf = new Date(Date.now() + 2 * 60_000);
    const after = encodeSearchCursor({
      asOf,
      from: new Date(asOf.getTime() - 48 * 3600_000),
      offset: 0,
    });
    const res = await page({ after });
    expect(res.body.errors).toBeUndefined();
  });
});
