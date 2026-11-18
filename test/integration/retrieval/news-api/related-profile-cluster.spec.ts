import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { NewsClusterArticlesResolver } from '../../../../apps/mera-server-news-api/src/modules/news-cluster-articles.resolver';
import { NewsClusterService } from '../../../../libs/mera-news-core/src/news-cluster/news-cluster.service';
import { CLIENT_DOCUMENTS } from '../../../../apps/mera-server-news-api/src/modules/client-documents';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import {
  hoursAgo,
  seedArticle,
  seedCluster,
  seedPublisher,
  seedSource,
} from '../support/fixtures';

const FEED = 'https://u:p@feeds.example.test/rss?token=abc';
const FEED_CLEAN = 'https://feeds.example.test/rss';

/** Compared as a boolean so a failure never prints the value (addresses can carry tokens). */
const same = (actual: unknown, expected: unknown) => actual === expected;

describe('related coverage, publication profiles, publisher order and cluster articles', () => {
  let api: NewsApi;

  beforeAll(async () => {
    // The harness runs in production mode. The membership score is shown only
    // outside it, so this resolver reads a configuration that says development.
    api = await bootNewsApi({
      override: (builder) =>
        builder.overrideProvider(NewsClusterArticlesResolver).useFactory({
          factory: (clusters: NewsClusterService) =>
            new NewsClusterArticlesResolver(clusters, {
              get: () => 'development',
            } as unknown as ConfigService),
          inject: [NewsClusterService],
        }),
    });
  });
  afterAll(() => api.close());
  beforeEach(() => api.resetDb());

  describe('relatedArticlesPage', () => {
    const op = CLIENT_DOCUMENTS.GetRelatedArticlesPage;
    type Page = {
      relatedArticlesPage: {
        articles: { _id: string; publication_name: string }[];
        pageInfo: { hasNextPage: boolean };
      };
    };
    const page = (variables: Record<string, unknown>) =>
      api.gql<Page>(op, variables);

    /** A viewed article plus three siblings from named sources, oldest last. */
    async function seedStory() {
      const names = ['Alpha Wire', 'Beta Wire', 'Gamma Wire'];
      const viewed = await seedArticle(api.connection, {
        source: await seedSource(api.connection, {
          publication_name: 'Viewed Wire',
        }),
      });
      const siblings: Types.ObjectId[] = [];
      for (const [i, name] of names.entries()) {
        siblings.push(
          await seedArticle(api.connection, {
            source: await seedSource(api.connection, {
              publication_name: name,
            }),
            createdAt: hoursAgo(1 + i),
          }),
        );
      }
      await seedCluster(api.connection, [viewed, ...siblings]);
      return { viewed, siblings };
    }

    it('returns the siblings of a seeded cluster, not the viewed article', async () => {
      const { viewed, siblings } = await seedStory();
      const res = await page({ articleId: String(viewed) });

      expect(res.body.errors).toBeUndefined();
      expect(
        res.body.data!.relatedArticlesPage.articles.map((a) => a._id).sort(),
      ).toEqual(siblings.map(String).sort());
    });

    it('orders NEWEST and OLDEST by date', async () => {
      const { viewed, siblings } = await seedStory();
      const newest = await page({
        articleId: String(viewed),
        sortMode: 'NEWEST',
      });
      const oldest = await page({
        articleId: String(viewed),
        sortMode: 'OLDEST',
      });

      expect(
        newest.body.data!.relatedArticlesPage.articles.map((a) => a._id),
      ).toEqual(siblings.map(String));
      expect(
        oldest.body.data!.relatedArticlesPage.articles.map((a) => a._id),
      ).toEqual([...siblings].reverse().map(String));
    });

    it('puts a subscribed publication first under RELEVANCE', async () => {
      const { viewed } = await seedStory();
      const res = await page({
        articleId: String(viewed),
        sortMode: 'RELEVANCE',
        context: { subscribedPublications: ['gamma wire'] },
      });

      expect(res.body.errors).toBeUndefined();
      expect(
        res.body.data!.relatedArticlesPage.articles.map(
          (a) => a.publication_name,
        )[0],
      ).toBe('Gamma Wire');
    });

    it('stores the reader context nowhere: no collection and no cache entry holds it', async () => {
      const { viewed } = await seedStory();
      const marker = 'zq7ctx41';
      const res = await page({
        articleId: String(viewed),
        sortMode: 'RELEVANCE',
        context: {
          homeCountryAlpha3: marker,
          appLanguageBase: marker,
          otherCountriesAlpha3: [marker],
          preferredPublications: [marker],
          preferredCountriesAlpha3: [marker],
          subscribedPublications: [marker],
        },
      });
      // The request was served, so the context reached the service.
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data!.relatedArticlesPage.articles.length).toBe(3);

      const db = api.connection.db!;
      const held: string[] = [];
      for (const { name } of await db.listCollections().toArray()) {
        for (const doc of await db.collection(name).find().toArray()) {
          if (JSON.stringify(doc).includes(marker)) held.push(name);
        }
      }
      expect(held).toEqual([]);

      const cache = api.app.get<{ stores?: { store?: unknown }[] }>(
        CACHE_MANAGER,
      );
      const maps = (cache.stores ?? [])
        .map((s) => s.store)
        .filter((s): s is Map<string, unknown> => s instanceof Map);
      expect(maps.length).toBeGreaterThan(0);
      for (const store of maps) {
        expect(JSON.stringify([...store.entries()]).includes(marker)).toBe(
          false,
        );
      }
    });

    it('refuses 201 excludeIds', async () => {
      const res = await page({
        articleId: String(new Types.ObjectId()),
        excludeIds: Array.from({ length: 201 }, () =>
          String(new Types.ObjectId()),
        ),
      });
      expect(res.body.errors?.[0].message).toMatch(/200/);
    });

    it.each([
      'otherCountriesAlpha3',
      'preferredPublications',
      'preferredCountriesAlpha3',
      'subscribedPublications',
    ])('refuses a context list %s of 51 items', async (field) => {
      const res = await page({
        articleId: String(new Types.ObjectId()),
        context: { [field]: Array.from({ length: 51 }, (_, i) => `n${i}`) },
      });
      expect(res.body.errors?.[0].message).toMatch(/50/);
    });

    it('accepts a context list of 50 items', async () => {
      const res = await page({
        articleId: String(new Types.ObjectId()),
        context: {
          subscribedPublications: Array.from({ length: 50 }, (_, i) => `n${i}`),
        },
      });
      expect(res.body.errors).toBeUndefined();
    });

    it.each([
      ['subscribedPublications', ['qz'.repeat(32) + 'x']],
      ['homeCountryAlpha3', 'qz'.repeat(32) + 'x'],
      ['appLanguageBase', 'qz'.repeat(32) + 'x'],
    ])(
      'refuses a 65-character context string in %s and does not echo it',
      async (field, value) => {
        const res = await page({
          articleId: String(new Types.ObjectId()),
          context: { [field]: value },
        });
        expect(res.body.errors?.[0].message).toMatch(/64/);
        expect(JSON.stringify(res.body).includes('qzqz')).toBe(false);
      },
    );

    it('answers an empty page, not an error, when nothing is clustered', async () => {
      const lone = await seedArticle(api.connection, {
        source: await seedSource(api.connection),
      });
      const res = await page({ articleId: String(lone) });

      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data!.relatedArticlesPage.articles).toEqual([]);
    });

    it('validates the filtered and legacy documents and applies the country filter', async () => {
      const { viewed } = await seedStory();
      const filtered = await api.gql<Page>(
        CLIENT_DOCUMENTS.GetRelatedArticlesPageFiltered,
        { articleId: String(viewed), countries: ['XXX'] },
      );
      const legacy = await api.gql<Page>(
        CLIENT_DOCUMENTS.GetRelatedArticlesPageLegacy,
        { articleId: String(viewed) },
      );

      expect(filtered.body.errors).toBeUndefined();
      expect(filtered.body.data!.relatedArticlesPage.articles).toEqual([]);
      expect(legacy.body.errors).toBeUndefined();
      expect(legacy.body.data!.relatedArticlesPage.articles).toHaveLength(3);
    });
  });

  describe('publicationProfile', () => {
    const op = CLIENT_DOCUMENTS.PublicationProfile;
    type Profile = {
      publicationProfile: {
        newsPublisherId: string;
        name: string;
        homepageUrl: string | null;
        subscriptionUri: string | null;
        sourceNames: string[];
      } | null;
    };
    const profile = (variables: Record<string, unknown>) =>
      api.gql<Profile>(op, variables);

    async function seedPaper() {
      const publisher = await seedPublisher(api.connection, {
        name: 'Paper Daily',
        website_url: 'https://u:p@paper.example.test/?token=x',
        subscription_uri: 'https://paper.example.test/subscribe?plan=a',
      });
      await seedSource(api.connection, {
        newsPublisherId: publisher,
        publication_name: 'Paper Daily',
        country_code: 'NLD',
      });
      return publisher;
    }

    it('answers a seeded publisher by id with the homepage address redacted', async () => {
      const publisher = await seedPaper();
      const res = await profile({ newsPublisherId: String(publisher) });

      expect(res.body.errors).toBeUndefined();
      const p = res.body.data!.publicationProfile!;
      expect(p.name).toBe('Paper Daily');
      expect(same(p.homepageUrl, 'https://paper.example.test/')).toBe(true);
      expect(p.sourceNames).toEqual(['Paper Daily']);
    });

    it('keeps the curated subscribe address as stored', async () => {
      const publisher = await seedPaper();
      const res = await profile({ newsPublisherId: String(publisher) });
      expect(
        same(
          res.body.data!.publicationProfile!.subscriptionUri,
          'https://paper.example.test/subscribe?plan=a',
        ),
      ).toBe(true);
    });

    it('answers by name plus country', async () => {
      const publisher = await seedPaper();
      const res = await profile({ name: 'Paper Daily', countryCode: 'nld' });

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data!.publicationProfile!.newsPublisherId).toBe(
        String(publisher),
      );
    });

    it('redacts the source address when the publisher has no homepage', async () => {
      const publisher = await seedPublisher(api.connection, {
        name: 'Bare',
        website_url: '',
      });
      await seedSource(api.connection, {
        newsPublisherId: publisher,
        publication_url: 'https://u:p@bare.example.test/home?token=x',
      });
      const res = await profile({ newsPublisherId: String(publisher) });
      expect(
        same(
          res.body.data!.publicationProfile!.homepageUrl,
          'https://bare.example.test/home',
        ),
      ).toBe(true);
    });

    it('answers null for an unknown publisher and for a malformed id', async () => {
      await seedPaper();
      const unknown = await profile({
        newsPublisherId: String(new Types.ObjectId()),
      });
      const byName = await profile({ name: 'Nobody', countryCode: 'NLD' });
      const malformed = await profile({ newsPublisherId: 'abcdefghijkl' });

      for (const res of [unknown, byName, malformed]) {
        expect(res.body.errors).toBeUndefined();
        expect(res.body.data!.publicationProfile).toBeNull();
      }
    });

    it('keeps BAD_PROFILE_KEY for a request with no usable key', async () => {
      const res = await profile({});
      expect(res.body.errors?.[0].extensions?.code).toBe('BAD_PROFILE_KEY');
    });

    it('refuses over-long arguments, names the limit and does not echo them', async () => {
      const long = 'qz'.repeat(100) + 'x';
      const name = await profile({ name: long, countryCode: 'NLD' });
      const country = await profile({ name: 'a', countryCode: 'qz'.repeat(5) });
      const language = await profile({
        name: 'a',
        countryCode: 'NLD',
        language: 'qz'.repeat(9),
      });

      expect(name.body.errors?.[0].message).toMatch(/200/);
      expect(country.body.errors?.[0].message).toMatch(/8/);
      expect(language.body.errors?.[0].message).toMatch(/16/);
      for (const res of [name, country, language]) {
        expect(JSON.stringify(res.body).includes('qzqz')).toBe(false);
      }
    });

    it('refuses a missing key like every other operation', async () => {
      const res = await api.gql(op, { name: 'a', countryCode: 'NLD' }, null);
      expect(res.body.errors?.[0].message).toBe('Invalid API key');
    });
  });

  describe('articlesForPublisher order', () => {
    const op = CLIENT_DOCUMENTS.GetArticlesForPublisher;
    type Publisher = { articlesForPublisher: { articles: { _id: string }[] } };
    const ids = (res: { body: { data?: Publisher | null } }) =>
      res.body.data!.articlesForPublisher.articles.map((a) => a._id);

    it('lists 48 hours newest first for NEWEST and the last 24 hours by default', async () => {
      const publisher = await seedPublisher(api.connection);
      const source = await seedSource(api.connection, {
        newsPublisherId: publisher,
      });
      const old = await seedArticle(api.connection, {
        source,
        createdAt: hoursAgo(30),
      });
      const mid = await seedArticle(api.connection, {
        source,
        createdAt: hoursAgo(3),
      });
      const fresh = await seedArticle(api.connection, {
        source,
        createdAt: hoursAgo(1),
      });
      const base = { newsPublisherId: String(publisher) };

      const newest = await api.gql<Publisher>(op, { ...base, order: 'NEWEST' });
      const dflt = await api.gql<Publisher>(op, base);
      const top = await api.gql<Publisher>(op, {
        ...base,
        order: 'TOP_HEADLINES',
      });

      expect(newest.body.errors).toBeUndefined();
      expect(ids(newest)).toEqual([fresh, mid, old].map(String));
      expect(ids(dflt).sort()).toEqual([fresh, mid].map(String).sort());
      expect(ids(top).sort()).toEqual(ids(dflt).sort());
    });
  });

  describe('NewsCluster.articles', () => {
    const op = CLIENT_DOCUMENTS.GetNewsClusterForArticle;
    type Cluster = {
      newsClusterForArticle: {
        articles: {
          articles: {
            _id: string;
            source_uri: string;
            clusterConfidence: number | null;
            publicationSource: { publication_url: string | null };
          }[];
          pageInfo: { endCursor: string | null; hasNextPage: boolean };
        };
      } | null;
    };

    async function seedLinked(count: number) {
      const source = await seedSource(api.connection, {
        publication_url: 'https://u:p@paper.example.test/home?token=x',
      });
      const articleIds: Types.ObjectId[] = [];
      for (let i = 0; i < count; i++) {
        articleIds.push(
          await seedArticle(api.connection, {
            source,
            overrides: { source_uri: FEED },
          }),
        );
      }
      await seedCluster(api.connection, articleIds);
      return articleIds;
    }

    it('pages by two over three links with after', async () => {
      const [a] = await seedLinked(3);
      const first = await api.gql<Cluster>(op, {
        articleId: String(a),
        first: 2,
      });
      const one = first.body.data!.newsClusterForArticle!.articles;
      const second = await api.gql<Cluster>(op, {
        articleId: String(a),
        first: 2,
        after: one.pageInfo.endCursor,
      });
      const two = second.body.data!.newsClusterForArticle!.articles;

      expect(first.body.errors).toBeUndefined();
      expect(one.articles).toHaveLength(2);
      expect(one.pageInfo.hasNextPage).toBe(true);
      expect(two.articles).toHaveLength(1);
      expect(two.pageInfo.hasNextPage).toBe(false);
      expect(
        new Set([...one.articles, ...two.articles].map((x) => x._id)).size,
      ).toBe(3);
    });

    it('caps a page at 50 and keeps a non-positive first small', async () => {
      const [a] = await seedLinked(52);
      const big = await api.gql<Cluster>(op, {
        articleId: String(a),
        first: 51,
      });
      const zero = await api.gql<Cluster>(op, {
        articleId: String(a),
        first: 0,
      });
      const negative = await api.gql<Cluster>(op, {
        articleId: String(a),
        first: -1,
      });

      const size = (r: typeof big) =>
        r.body.data!.newsClusterForArticle!.articles.articles.length;
      expect(size(big)).toBe(50);
      expect(size(zero)).toBeLessThanOrEqual(1);
      expect(size(negative)).toBeLessThanOrEqual(1);
    });

    it('serves member addresses without their secrets', async () => {
      const [a] = await seedLinked(2);
      const res = await api.gql<Cluster>(op, { articleId: String(a) });
      for (const m of res.body.data!.newsClusterForArticle!.articles.articles) {
        expect(same(m.source_uri, FEED_CLEAN)).toBe(true);
        expect(
          same(
            m.publicationSource.publication_url,
            'https://paper.example.test/home',
          ),
        ).toBe(true);
      }
    });

    it('shows the membership score outside production', async () => {
      const [a] = await seedLinked(2);
      const res = await api.gql<Cluster>(op, { articleId: String(a) });
      expect(
        res.body.data!.newsClusterForArticle!.articles.articles.map(
          (m) => m.clusterConfidence,
        ),
      ).toEqual([0.9, 0.9]);
    });
  });
});

describe('keyset cursors are caller input', () => {
  let api: NewsApi;
  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());

  const cursor = (payload: unknown) =>
    Buffer.from(JSON.stringify(payload)).toString('base64');
  const bad = [
    cursor({ createdAt: new Date().toISOString(), _id: 'not-an-object-id' }),
    cursor({ createdAt: 'not a date', _id: String(new Types.ObjectId()) }),
    'not base64 json',
  ];
  const id = () => String(new Types.ObjectId());

  it.each(bad)(
    'answers a bad request, never a server error, for %s',
    async (after) => {
      const queries = [
        `{ articlesForCountry(countryCode: "GBR", after: ${JSON.stringify(after)}) { pageInfo { hasNextPage } } }`,
        `{ articlesForPublisher(newsPublisherId: "${id()}", after: ${JSON.stringify(after)}) { pageInfo { hasNextPage } } }`,
        `{ articlesForPublicationSource(publicationSourceId: "${id()}", after: ${JSON.stringify(after)}) { pageInfo { hasNextPage } } }`,
        `{ newsPublishers(after: ${JSON.stringify(after)}) { pageInfo { hasNextPage } } }`,
      ];
      for (const query of queries) {
        const res = await api.gql(query);
        expect(res.body.errors?.[0].message).toBe(
          'after is not a valid cursor',
        );
      }
    },
  );

  it('refuses a bad cursor on the cluster articles field', async () => {
    const source = await seedSource(api.connection);
    const a = await seedArticle(api.connection, { source });
    const b = await seedArticle(api.connection, { source });
    await seedCluster(api.connection, [a, b]);

    const res = await api.gql(
      `query($id: ID!, $after: String) { newsClusterForArticle(articleId: $id) { articles(after: $after) { pageInfo { hasNextPage } } } }`,
      { id: String(a), after: bad[0] },
    );
    expect(res.body.errors?.[0].message).toBe('after is not a valid cursor');
  });
});

describe('NewsCluster.articles in production', () => {
  let api: NewsApi;
  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());
  beforeEach(() => api.resetDb());

  it('hides clusterConfidence', async () => {
    const source = await seedSource(api.connection);
    const a = await seedArticle(api.connection, { source });
    const b = await seedArticle(api.connection, { source });
    await seedCluster(api.connection, [a, b]);

    const res = await api.gql<{
      newsClusterForArticle: {
        articles: { articles: { clusterConfidence: number | null }[] };
      };
    }>(CLIENT_DOCUMENTS.GetNewsClusterForArticle, { articleId: String(a) });

    expect(res.body.errors).toBeUndefined();
    expect(
      res.body.data!.newsClusterForArticle.articles.articles.map(
        (m) => m.clusterConfidence,
      ),
    ).toEqual([null, null]);
  });
});

describe('query limits on NewsCluster.articles', () => {
  let api: NewsApi;
  beforeAll(async () => {
    api = await bootNewsApi({ env: { NEWS_API_MAX_QUERY_DEPTH: '3' } });
  });
  afterAll(() => api.close());

  const id = () => String(new Types.ObjectId());

  it('refuses the cluster articles field one level too deep before any resolver runs', async () => {
    const res = await api.gql(
      `{ newsClusterForArticle(articleId: "${id()}") { articles { articles { _id } } } }`,
    );
    expect(res.body.errors?.[0].extensions?.code).toBe('QUERY_TOO_COMPLEX');
    expect(res.body.data ?? null).toBeNull();
  });

  it('accepts it at the limit and runs the field resolver', async () => {
    await api.resetDb();
    const source = await seedSource(api.connection);
    const a = await seedArticle(api.connection, { source });
    const b = await seedArticle(api.connection, { source });
    await seedCluster(api.connection, [a, b]);

    const res = await api.gql<{
      newsClusterForArticle: { articles: { __typename: string } };
    }>(
      `{ newsClusterForArticle(articleId: "${String(a)}") { articles { __typename } } }`,
    );
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.newsClusterForArticle.articles.__typename).toBe(
      'ClusterArticlesConnection',
    );
  });

  it('refuses many aliases of the field in one query', async () => {
    const aliases = Array.from(
      { length: 1001 },
      (_, i) => `a${i}: articles(first: 50) { pageInfo { hasNextPage } }`,
    ).join(' ');
    const res = await api.gql(
      `{ newsClusterForArticle(articleId: "${id()}") { ${aliases} } }`,
    );
    expect(res.body.errors?.[0].extensions?.code).toBe('QUERY_TOO_COMPLEX');
  });
});
