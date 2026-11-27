import { getModelToken } from '@nestjs/mongoose';
import { Aggregate, type Model } from 'mongoose';
import { NewsArticle } from '@mera/models/models/news-article.model';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import {
  hoursAgo,
  seedArticle,
  seedCluster,
  seedHeadlineEdition,
  seedSource,
} from '../support/fixtures';

type Headlines = {
  topHeadlinesForCountry: {
    headlines: {
      article: { _id: string };
      cursor: string | null;
      publisherCount: number;
    }[];
    pageInfo: {
      endCursor: string | null;
      hasNextPage: boolean;
      pageSize: number;
    };
    editionBuiltAt: string | null;
  };
};

const HEADLINES =
  'query($c: String, $first: Int, $after: String, $w: Int) { topHeadlinesForCountry(countryCode: $c, first: $first, after: $after, windowHours: $w) { headlines { article { _id } cursor publisherCount } pageInfo { endCursor hasNextPage pageSize } editionBuiltAt } }';

type Country = {
  articlesForCountry: {
    articles: { _id: string }[];
    itemCursors: string[];
    pageInfo: { endCursor: string | null; hasNextPage: boolean };
  };
};

const COUNTRY =
  'query($c: String, $first: Int, $after: String, $order: PublisherArticleOrder) { articlesForCountry(countryCode: $c, first: $first, after: $after, order: $order) { articles { _id } itemCursors pageInfo { endCursor hasNextPage } } }';

const ids = (page: { _id: string }[]) => page.map((a) => a._id);

describe('paging headlines and country articles', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());
  beforeEach(() => api.resetDb());

  const headlines = (variables: Record<string, unknown>) =>
    api.gql<Headlines>(HEADLINES, { c: 'NLD', ...variables });
  const country = (variables: Record<string, unknown>) =>
    api.gql<Country>(COUNTRY, { c: 'NLD', ...variables });

  async function seedNld(count: number) {
    const source = await seedSource(api.connection, { country_code: 'NLD' });
    const out = [];
    for (let i = 0; i < count; i++) {
      out.push(
        await seedArticle(api.connection, {
          source,
          createdAt: hoursAgo(1 + i),
        }),
      );
    }
    return out;
  }

  describe('articlesForCountry TOP_HEADLINES', () => {
    it('clamps first like topHeadlinesForCountry', async () => {
      await seedNld(3);
      const find = jest.spyOn(Aggregate.prototype, 'exec');
      try {
        const res = await country({ first: 100_000 });
        expect(res.body.errors).toBeUndefined();
        const limits = find.mock.contexts.flatMap((agg) =>
          (agg.pipeline() as Record<string, number>[])
            .map((stage) => stage.$limit)
            .filter((n) => typeof n === 'number'),
        );
        expect(Math.max(...limits)).toBeLessThanOrEqual(201);
      } finally {
        find.mockRestore();
      }
    });
  });

  describe('topHeadlinesForCountry', () => {
    it.each([
      ['0', 0, 1],
      ['a negative number', -3, 1],
      ['a huge number', 100_000, 200],
    ])('clamps first given %s', async (_, first, pageSize) => {
      await seedHeadlineEdition(api.connection, 'NLD', await seedNld(3));
      const res = await headlines({ first });
      expect(res.body.errors).toBeUndefined();
      const page = res.body.data!.topHeadlinesForCountry;
      expect(page.pageInfo.pageSize).toBe(pageSize);
      expect(page.headlines).toHaveLength(Math.min(pageSize, 3));
    });

    it('continues right after any headline given its cursor', async () => {
      const articles = await seedNld(5);
      await seedHeadlineEdition(api.connection, 'NLD', articles);
      const seeded = articles.map(String);
      const first = await headlines({ first: 3 });
      const kept = first.body.data!.topHeadlinesForCountry.headlines[1];
      expect(kept.article._id).toBe(seeded[1]);

      const next = await headlines({ first: 10, after: kept.cursor });
      expect(next.body.errors).toBeUndefined();
      expect(
        next.body.data!.topHeadlinesForCountry.headlines.map(
          (h) => h.article._id,
        ),
      ).toEqual(seeded.slice(2));
    });

    it('answers EDITION_CHANGED for a headline cursor once the edition is rebuilt, and keeps paging by endCursor', async () => {
      const seeded = await seedNld(4);
      await seedHeadlineEdition(api.connection, 'NLD', seeded);
      const first = (await headlines({ first: 2 })).body.data!
        .topHeadlinesForCountry;

      await api.connection
        .collection('headline-edition')
        .updateOne(
          { scopeKey: 'NLD' },
          { $set: { builtAt: new Date(Date.now() + 1000) } },
        );

      const stale = await headlines({
        first: 2,
        after: first.headlines[1].cursor,
      });
      expect(stale.body.errors?.[0].extensions?.code).toBe('EDITION_CHANGED');

      const byEnd = await headlines({
        first: 2,
        after: first.pageInfo.endCursor,
      });
      expect(byEnd.body.errors).toBeUndefined();
      expect(
        byEnd.body.data!.topHeadlinesForCountry.headlines.map(
          (h) => h.article._id,
        ),
      ).toEqual(seeded.slice(2).map(String));
    });

    it('serves the publisher count stored on the entry, and 0 for an edition built without it', async () => {
      const source = await seedSource(api.connection, { country_code: 'NLD' });
      const a = await seedArticle(api.connection, { source });
      const b = await seedArticle(api.connection, { source });
      const c = await seedArticle(api.connection, { source });
      await seedCluster(api.connection, [a, b], {
        stableClusterId: 'with-count',
      });
      await seedCluster(
        api.connection,
        [c, await seedArticle(api.connection, { source })],
        {
          stableClusterId: 'old-entry',
        },
      );
      const lone = await seedArticle(api.connection, { source });
      await api.connection.collection('headline-edition').insertOne({
        scopeKey: 'NLD',
        windowHours: 48,
        builtAt: new Date(),
        buildRunId: 'publisher-count',
        entryCount: 3,
        entries: [
          {
            articleId: a,
            clusterId: null,
            stableClusterId: 'with-count',
            clusterSize: 2,
            inScopeCount: 2,
            rank: 0,
            publisherCount: 2,
          },
          {
            articleId: c,
            clusterId: null,
            stableClusterId: 'old-entry',
            clusterSize: 2,
            inScopeCount: 2,
            rank: 1,
          },
          {
            articleId: lone,
            clusterId: null,
            stableClusterId: null,
            clusterSize: 0,
            inScopeCount: 1,
            rank: 2,
            publisherCount: 0,
          },
        ],
        views: [],
      });
      const res = await headlines({});
      expect(res.body.errors).toBeUndefined();
      expect(
        res.body.data!.topHeadlinesForCountry.headlines.map(
          (h) => h.publisherCount,
        ),
      ).toEqual([2, 0, 0]);
    });

    it("reads a view's own list, and the 24h list from an edition built before views", async () => {
      const [a, b] = await seedNld(2);
      const entry = (articleId: unknown, rank: number) => ({
        articleId,
        clusterId: null,
        stableClusterId: null,
        clusterSize: 0,
        inScopeCount: 1,
        rank,
      });
      await api.connection.collection('headline-edition').insertMany([
        {
          scopeKey: 'NLD',
          windowHours: 48,
          builtAt: new Date(),
          buildRunId: 'views',
          entryCount: 2,
          entries: [entry(a, 0), entry(b, 1)],
          views: [{ windowHours: 6, entryCount: 1, entries: [entry(b, 0)] }],
        },
        {
          scopeKey: 'BEL',
          windowHours: 48,
          builtAt: new Date(),
          buildRunId: 'no-views',
          entryCount: 1,
          entries: [entry(a, 0)],
        },
      ]);
      const six = await headlines({ w: 6 });
      expect(
        six.body.data!.topHeadlinesForCountry.headlines.map(
          (h) => h.article._id,
        ),
      ).toEqual([String(b)]);
      const twelve = await headlines({ w: 12 });
      expect(
        twelve.body.data!.topHeadlinesForCountry.headlines.map(
          (h) => h.article._id,
        ),
      ).toEqual([String(a), String(b)]);
      const old = await headlines({ c: 'BEL', w: 6 });
      expect(
        old.body.data!.topHeadlinesForCountry.headlines.map(
          (h) => h.article._id,
        ),
      ).toEqual([String(a)]);
    });

    it('pages the cold-scope fallback with cursors the resolver accepts', async () => {
      const seeded = (await seedNld(3)).map(String);
      const seen: string[] = [];
      let after: string | null = null;
      for (let calls = 0; calls < 5; calls++) {
        const res: Awaited<ReturnType<typeof headlines>> = await headlines({
          first: 1,
          after,
        });
        expect(res.body.errors).toBeUndefined();
        const page = res.body.data!.topHeadlinesForCountry;
        expect(page.editionBuiltAt).toBeNull();
        seen.push(...page.headlines.map((h) => h.article._id));
        after = page.pageInfo.endCursor;
        if (!page.pageInfo.hasNextPage) break;
      }
      expect(seen).toEqual(seeded);

      const first = (await headlines({ first: 2 })).body.data!
        .topHeadlinesForCountry;
      const next = await headlines({
        first: 2,
        after: first.headlines[0].cursor,
      });
      expect(next.body.errors).toBeUndefined();
      expect(
        next.body.data!.topHeadlinesForCountry.headlines.map(
          (h) => h.article._id,
        ),
      ).toEqual(seeded.slice(1));
    });
  });

  describe('articlesForCountry', () => {
    it('orders NEWEST by arrival, where TOP_HEADLINES leads with the biggest story', async () => {
      const [newest, middle, oldest] = await seedNld(3);
      await seedCluster(api.connection, [oldest]);
      const top = await country({});
      expect(ids(top.body.data!.articlesForCountry.articles)[0]).toBe(
        String(oldest),
      );

      const res = await country({ order: 'NEWEST' });
      expect(res.body.errors).toBeUndefined();
      expect(ids(res.body.data!.articlesForCountry.articles)).toEqual(
        [newest, middle, oldest].map(String),
      );
    });

    it.each(['TOP_HEADLINES', 'NEWEST'])(
      'gives %s one cursor per article that continues right after it',
      async (order) => {
        const seeded = (await seedNld(4)).map(String);
        const page = (await country({ order, first: 3 })).body.data!
          .articlesForCountry;
        expect(page.itemCursors).toHaveLength(page.articles.length);
        expect(page.itemCursors[2]).toBe(page.pageInfo.endCursor);

        const next = await country({
          order,
          first: 10,
          after: page.itemCursors[0],
        });
        expect(next.body.errors).toBeUndefined();
        expect(ids(next.body.data!.articlesForCountry.articles)).toEqual(
          seeded.slice(1),
        );
      },
    );

    it('serves GLOBAL NEWEST from an index, with no in-memory sort', async () => {
      const model = api.app.get<Model<NewsArticle>>(
        getModelToken(NewsArticle.name),
      );
      await model.init();
      await seedNld(60);
      const pipelines: unknown[][] = [];
      const original = Aggregate.prototype.exec;
      const exec = jest
        .spyOn(Aggregate.prototype, 'exec')
        .mockImplementation(function (this: Aggregate<unknown>) {
          pipelines.push(this.pipeline());
          return original.call(this);
        });
      try {
        const res = await country({ c: 'GLOBAL', order: 'NEWEST', first: 5 });
        expect(res.body.errors).toBeUndefined();
      } finally {
        exec.mockRestore();
      }
      expect(pipelines).toHaveLength(1);
      const explained = (await api.connection
        .db!.collection('news-article')
        .aggregate(pipelines[0] as object[])
        .explain('queryPlanner')) as unknown as {
        stages: { $cursor?: { queryPlanner: { winningPlan: unknown } } }[];
      };
      const plan = JSON.stringify(
        explained.stages[0].$cursor!.queryPlanner.winningPlan,
      );
      expect(plan).toContain('createdAt_-1__id_-1');
      expect(plan).not.toContain('"stage":"SORT"');
    });
  });
});
