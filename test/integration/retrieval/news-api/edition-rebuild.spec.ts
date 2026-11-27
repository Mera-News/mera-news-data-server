import { QueueName } from '@mera/shared';
import { CLIENT_DOCUMENTS } from '../../../../apps/mera-server-news-api/src/modules/client-documents';
import { bootAsyncApp, type Harness } from '../../../harness/boot';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import {
  hoursAgo,
  seedArticle,
  seedCluster,
  seedPublisher,
  seedSource,
} from '../support/fixtures';

type Headlines = {
  topHeadlinesForCountry: {
    headlines: {
      article: { _id: string };
      clusterSize: number;
      publisherCount: number;
      cursor: string | null;
    }[];
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
    editionBuiltAt: string | null;
  };
};

const COUNTS =
  'query($after: String) { topHeadlinesForCountry(countryCode: "NLD", first: 10, after: $after) { headlines { article { _id } clusterSize publisherCount cursor } pageInfo { endCursor hasNextPage } editionBuiltAt } }';

// The edition the worker builds, read through the news API.
describe('headline editions across a rebuild', () => {
  jest.setTimeout(60_000);
  let h: Harness;
  let api: NewsApi;

  beforeAll(async () => {
    h = await bootAsyncApp();
    api = await bootNewsApi();
  });
  afterAll(async () => {
    await api?.close();
    await h?.close();
  });
  beforeEach(() => h.resetDb());

  const build = () => h.runJob(QueueName.BUILD_HEADLINE_EDITIONS, {});

  /**
   * A story from three feeds of two publishers, one from two feeds of one
   * publisher, and two lone articles.
   */
  async function seedStories() {
    const p1 = await seedPublisher(h.connection);
    const p2 = await seedPublisher(h.connection);
    const s1 = await seedSource(h.connection, { newsPublisherId: p1 });
    const s2 = await seedSource(h.connection, { newsPublisherId: p1 });
    const s3 = await seedSource(h.connection, { newsPublisherId: p2 });
    const at = (source: typeof s1, hours: number) =>
      seedArticle(h.connection, { source, createdAt: hoursAgo(hours) });
    const wide = [await at(s1, 1), await at(s2, 2), await at(s3, 3)];
    const narrow = [await at(s1, 1), await at(s2, 2)];
    await at(s3, 1);
    await at(s3, 2);
    await seedCluster(h.connection, wide);
    await seedCluster(h.connection, narrow);
    return { s3 };
  }

  it('stores and serves the distinct publishers of each story, 0 for a lone article', async () => {
    await seedStories();
    await build();

    const res = await api.gql<Headlines>(COUNTS);
    expect(res.body.errors).toBeUndefined();
    const rows = res.body.data!.topHeadlinesForCountry.headlines.map((x) => [
      x.clusterSize,
      x.publisherCount,
    ]);
    expect(rows).toEqual([
      [3, 2],
      [2, 1],
      [0, 0],
      [0, 0],
    ]);
  });

  it('writes every scope when editions outnumber one write batch, and counts a story\'s publishers in every country', async () => {
    // More country scopes than EDITION_WRITE_BATCH (20), so the build writes in several batches.
    const countries = Array.from({ length: 25 }, (_, i) => `C${String(i).padStart(2, '0')}`);
    for (const country_code of countries) {
      const source = await seedSource(h.connection, { country_code });
      await seedArticle(h.connection, { source, createdAt: hoursAgo(1) });
    }
    // One story told in NLD and in DEU by two publishers: the NLD edition counts both.
    const nl = await seedSource(h.connection, { country_code: 'NLD', newsPublisherId: await seedPublisher(h.connection) });
    const de = await seedSource(h.connection, { country_code: 'DEU', newsPublisherId: await seedPublisher(h.connection) });
    await seedCluster(h.connection, [
      await seedArticle(h.connection, { source: nl, createdAt: hoursAgo(1) }),
      await seedArticle(h.connection, { source: de, createdAt: hoursAgo(2) }),
    ]);
    await build();

    const scopes = await h.connection.collection('headline-edition').distinct('scopeKey');
    expect(scopes.sort()).toEqual(['DEU', 'GLOBAL', 'NLD', ...countries].sort());
    const res = await api.gql<Headlines>(COUNTS);
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.topHeadlinesForCountry.headlines.map((x) => x.publisherCount)).toEqual([2]);
  });

  it.each([
    ['GetTopHeadlinesForCountry', {}],
    ['GetTopHeadlinesForCountryWindowed', { windowHours: 24 }],
  ] as const)(
    'keeps the app document %s paging by endCursor after a rebuild',
    async (name, extra) => {
      const { s3 } = await seedStories();
      await build();
      const doc = CLIENT_DOCUMENTS[name];
      const vars = { countryCode: 'NLD', first: 2, ...extra };
      const first = await api.gql<Headlines>(doc, vars);
      expect(first.body.errors).toBeUndefined();
      const page = first.body.data!.topHeadlinesForCountry;
      expect(page.pageInfo.hasNextPage).toBe(true);
      const cursorRes = await api.gql<Headlines>(COUNTS);
      const headlineCursor =
        cursorRes.body.data!.topHeadlinesForCountry.headlines[1].cursor;

      // A new lone article, and a new edition.
      await seedArticle(h.connection, { source: s3, createdAt: hoursAgo(4) });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await build();

      const second = await api.gql<Headlines>(doc, {
        ...vars,
        after: page.pageInfo.endCursor,
      });
      expect(second.body.errors).toBeUndefined();
      expect(second.body.data!.topHeadlinesForCountry.headlines).toHaveLength(
        2,
      );
      expect(second.body.data!.topHeadlinesForCountry.editionBuiltAt).not.toBe(
        page.editionBuiltAt,
      );

      const stale = await api.gql<Headlines>(COUNTS, { after: headlineCursor });
      expect(stale.body.errors?.[0].extensions?.code).toBe('EDITION_CHANGED');
    },
  );
});
