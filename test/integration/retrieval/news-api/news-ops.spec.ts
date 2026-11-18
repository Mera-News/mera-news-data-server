import mongoose, { Types } from 'mongoose';
import { getIntrospectionQuery } from 'graphql';
import { CLIENT_DOCUMENTS } from '../../../../apps/mera-server-news-api/src/modules/client-documents';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import {
  seedArticle,
  seedCluster,
  seedPublisher,
  seedSource,
} from '../support/fixtures';

const hexIds = (n: number) =>
  Array.from({ length: n }, () => new Types.ObjectId().toString());

/** Compared as a boolean so a failure never prints the value (feed URLs can carry tokens). */
const same = (actual: unknown, expected: unknown) => actual === expected;

describe('news API operations for the client', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());
  beforeEach(() => api.resetDb());

  describe('publicationSourcesForNewsPublisher', () => {
    const op = CLIENT_DOCUMENTS.PublicationSourcesForNewsPublisher;

    it('returns the sources of a seeded publisher', async () => {
      const publisher = await seedPublisher(api.connection);
      const a = await seedSource(api.connection, {
        newsPublisherId: publisher,
        publication_name: 'Alpha Wire',
      });
      await seedSource(api.connection, {
        newsPublisherId: publisher,
        publication_name: 'Beta Wire',
      });
      await seedSource(api.connection);

      const res = await api.gql<{
        publicationSourcesForNewsPublisher: {
          publicationSources: { _id: string; publication_name: string }[];
        };
      }>(op, { publisherId: String(publisher) });

      expect(res.body.errors).toBeUndefined();
      const sources =
        res.body.data!.publicationSourcesForNewsPublisher.publicationSources;
      expect(sources.map((s) => s.publication_name)).toEqual([
        'Alpha Wire',
        'Beta Wire',
      ]);
      expect(sources[0]._id).toBe(String(a._id));
    });

    it.each(['not-an-id', '', '12345', 'g'.repeat(24)])(
      'answers an empty list for the malformed id %p',
      async (publisherId) => {
        const res = await api.gql<{
          publicationSourcesForNewsPublisher: { publicationSources: unknown[] };
        }>(op, { publisherId });

        expect(res.status).toBe(200);
        expect(res.body.errors).toBeUndefined();
        expect(res.body.data!.publicationSourcesForNewsPublisher).toEqual({
          publicationSources: [],
        });
      },
    );
  });

  describe('searchPublishers', () => {
    const op = CLIENT_DOCUMENTS.SearchPublishers;
    const search = (variables: Record<string, unknown>) =>
      api.gql<{
        searchPublishers: { publishers: { name: string }[] };
      }>(op, variables);

    it('finds a publisher by name', async () => {
      await seedPublisher(api.connection, { name: 'Zephyr Gazette' });
      await seedPublisher(api.connection, { name: 'Other Paper' });

      const res = await search({ query: 'zephyr' });

      expect(res.body.errors).toBeUndefined();
      expect(
        res.body.data!.searchPublishers.publishers.map((p) => p.name),
      ).toEqual(['Zephyr Gazette']);
    });

    it('refuses a query of 65 characters and names the limit without echoing it', async () => {
      const query = 'q'.repeat(65);
      const res = await search({ query });

      expect(res.body.errors?.[0].message).toMatch(/64/);
      expect(res.body.errors?.[0].message).not.toContain(query);
    });

    it('refuses a query of one character', async () => {
      const res = await search({ query: 'a' });
      expect(res.body.errors?.[0].message).toMatch(/2/);
    });

    it('refuses first: 51 and an after cursor over 512 characters', async () => {
      const first = await search({ query: 'paper', first: 51 });
      expect(first.body.errors?.[0].message).toMatch(/50/);

      const after = 'c'.repeat(513);
      const cursor = await search({ query: 'paper', after });
      expect(cursor.body.errors?.[0].message).toMatch(/512/);
      expect(cursor.body.errors?.[0].message).not.toContain(after);
    });

    it('answers a backtracking pattern and a 10 kB string within 2 s', async () => {
      await seedPublisher(api.connection, { name: 'aaaaaaaa' });
      for (const query of [
        '(a+)+$' + 'a'.repeat(30) + '!',
        'x'.repeat(10_000),
      ]) {
        const started = Date.now();
        const res = await search({ query });
        expect(Date.now() - started).toBeLessThan(2000);
        expect(res.status).toBe(200);
        const publishers = res.body.data?.searchPublishers.publishers ?? [];
        expect(publishers.length).toBeLessThanOrEqual(50);
        if (res.body.errors) expect(res.body.errors[0].message).toMatch(/64/);
      }
    });

    it('bounds both scans with maxTimeMS', async () => {
      const seen: { collection: string; options: unknown }[] = [];
      mongoose.set(
        'debug',
        (collection: string, method: string, ...rest: unknown[]) => {
          if (method === 'find')
            seen.push({ collection, options: rest[rest.length - 1] });
        },
      );
      try {
        await search({ query: 'paper' });
      } finally {
        mongoose.set('debug', false);
      }
      const bounded = seen.filter(
        (s) =>
          (s.options as { maxTimeMS?: number } | undefined)?.maxTimeMS === 2000,
      );
      expect(bounded.map((s) => s.collection).sort()).toEqual([
        'news-publisher',
        'publication-source',
      ]);
    });

    it('matches the pattern as plain text', async () => {
      await seedPublisher(api.connection, { name: 'aaaa' });
      const res = await search({ query: '(a+)+$' });
      expect(res.body.data!.searchPublishers.publishers).toEqual([]);
    });
  });

  describe('articlesForStories', () => {
    const op = CLIENT_DOCUMENTS.GetArticlesForStories;
    const story = (ids: string[]) =>
      api.gql<{
        articlesForStories: {
          articles: { _id: string; clusters: unknown[] }[];
        };
      }>(op, { articleIds: ids });

    it('hydrates 50 ids with empty clusters when nothing is clustered', async () => {
      const source = await seedSource(api.connection);
      const ids: string[] = [];
      for (let i = 0; i < 50; i++) {
        ids.push(String(await seedArticle(api.connection, { source })));
      }

      const res = await story(ids);

      expect(res.body.errors).toBeUndefined();
      const articles = res.body.data!.articlesForStories.articles;
      expect(articles).toHaveLength(50);
      expect(articles.every((a) => a.clusters.length === 0)).toBe(true);
    });

    it('refuses 51 ids', async () => {
      const res = await story(hexIds(51));
      expect(res.body.errors?.[0].message).toMatch(/50/);
    });

    it('serves clusters when the article is clustered, and skips unknown and invalid ids', async () => {
      const source = await seedSource(api.connection);
      const id = await seedArticle(api.connection, { source });
      await seedCluster(api.connection, [id], { stableClusterId: 'story-1' });

      const res = await story([String(id), hexIds(1)[0], 'not-an-id']);

      expect(res.body.errors).toBeUndefined();
      const articles = res.body.data!.articlesForStories.articles;
      expect(articles).toHaveLength(1);
      expect(articles[0].clusters).toMatchObject([
        { stableClusterId: 'story-1' },
      ]);
    });
  });

  describe('clusterMembershipsForArticles', () => {
    const op = CLIENT_DOCUMENTS.ClusterMembershipsForArticles;
    const memberships = (ids: string[]) =>
      api.gql<{
        clusterMembershipsForArticles: {
          articleId: string;
          clusters: unknown[];
        }[];
      }>(op, { articleIds: ids });

    it('accepts 500 ids and refuses 501', async () => {
      const ok = await memberships(hexIds(500));
      expect(ok.body.errors).toBeUndefined();

      const refused = await memberships(hexIds(501));
      expect(refused.body.errors?.[0].message).toMatch(/500/);
    });

    it('answers clusters: [] for a valid id when nothing is clustered, and skips a malformed id', async () => {
      const source = await seedSource(api.connection);
      const id = String(await seedArticle(api.connection, { source }));

      const res = await memberships([id, 'not-an-id']);

      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data!.clusterMembershipsForArticles).toEqual([
        { articleId: id, clusters: [] },
      ]);
    });

    it('answers the cluster of a clustered article', async () => {
      const source = await seedSource(api.connection);
      const id = await seedArticle(api.connection, { source });
      await seedCluster(api.connection, [id], { stableClusterId: 'member-1' });

      const res = await memberships([String(id)]);

      expect(
        res.body.data!.clusterMembershipsForArticles[0].clusters,
      ).toMatchObject([{ stableClusterId: 'member-1' }]);
    });
  });

  describe('topHeadlinesForCountry', () => {
    const op = CLIENT_DOCUMENTS.GetTopHeadlinesForCountryWindowed;
    const headlines = (variables: Record<string, unknown>) =>
      api.gql<{
        topHeadlinesForCountry: { editionBuiltAt: string | null };
      }>(op, variables);

    it('accepts windowHours: 12 and falls back to the live path with no edition', async () => {
      const res = await headlines({ countryCode: 'NLD', windowHours: 12 });

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data!.topHeadlinesForCountry.editionBuiltAt).toBeNull();
    });

    it('refuses windowHours: 7 with BAD_WINDOW', async () => {
      const res = await headlines({ countryCode: 'NLD', windowHours: 7 });
      expect(res.body.errors?.[0].extensions?.code).toBe('BAD_WINDOW');
    });

    it('refuses a country code over 8 characters and an after cursor over 512', async () => {
      const code = await headlines({ countryCode: 'NLDNLDNLD' });
      expect(code.body.errors?.[0].message).toMatch(/8/);

      const after = await headlines({
        countryCode: 'NLD',
        after: 'c'.repeat(513),
      });
      expect(after.body.errors?.[0].message).toMatch(/512/);
    });
  });
});

describe('news API source URLs', () => {
  const FEED = 'https://u:p@feeds.example.test/rss?token=abc';
  const PAGE = 'https://u:p@www.example.test/home?session=xyz';
  const FIELDS = '_id feed_url publication_url last_fetch_error';
  const BY_PUBLISHER = `query($id: ID!) { publicationSourcesForNewsPublisher(publisherId: $id) { publicationSources { ${FIELDS} } } }`;
  const BY_LIST = `{ newsPublishers { newsPublishers { publicationSources { ${FIELDS} } } } }`;
  const BY_ARTICLE = `query($id: ID!) { articleById(id: $id) { publicationSource { ${FIELDS} } } }`;
  const BY_SEARCH = `{ searchPublishers(query: "Redact") { publishers { matchingSources { ${FIELDS} } } } }`;

  type Source = {
    feed_url: string;
    publication_url: string | null;
    last_fetch_error: string | null;
  };

  async function seed(api: NewsApi) {
    await api.resetDb();
    const publisher = await seedPublisher(api.connection, {
      name: 'Redact Wire',
    });
    const source = await seedSource(api.connection, {
      newsPublisherId: publisher,
      publication_name: 'Redact Daily',
      feed_url: FEED,
      publication_url: PAGE,
      last_fetch_error: 'timeout reaching the feed',
    });
    const article = await seedArticle(api.connection, { source });
    return { publisher: String(publisher), article: String(article) };
  }

  async function allSources(api: NewsApi, apiKey: string | null) {
    const { publisher, article } = await seed(api);
    const [a, b, c, d] = await Promise.all([
      api.gql<{
        publicationSourcesForNewsPublisher: { publicationSources: Source[] };
      }>(BY_PUBLISHER, { id: publisher }, apiKey),
      api.gql<{
        newsPublishers: {
          newsPublishers: { publicationSources: Source[] }[];
        };
      }>(BY_LIST, {}, apiKey),
      api.gql<{ articleById: { publicationSource: Source } }>(
        BY_ARTICLE,
        { id: article },
        apiKey,
      ),
      api.gql<{
        searchPublishers: { publishers: { matchingSources: Source[] }[] };
      }>(BY_SEARCH, {}, apiKey),
    ]);
    for (const res of [a, b, c, d]) expect(res.body.errors).toBeUndefined();
    return [
      a.body.data!.publicationSourcesForNewsPublisher.publicationSources[0],
      b.body.data!.newsPublishers.newsPublishers[0].publicationSources[0],
      c.body.data!.articleById.publicationSource,
      d.body.data!.searchPublishers.publishers[0].matchingSources[0],
    ];
  }

  describe('article source_uri', () => {
    let api: NewsApi;
    beforeAll(async () => {
      api = await bootNewsApi();
    });
    afterAll(() => api.close());

    const byId = `query($id: ID!) { articleById(id: $id) { source_uri } }`;
    async function sourceUriOf(stored: string) {
      await api.resetDb();
      const source = await seedSource(api.connection);
      const id = await seedArticle(api.connection, {
        source,
        overrides: { source_uri: stored },
      });
      const res = await api.gql<{ articleById: { source_uri: string } }>(
        byId,
        { id: String(id) },
        'news-api-test-key',
      );
      expect(res.body.errors).toBeUndefined();
      return res.body.data!.articleById.source_uri;
    }

    it('serves origin plus path for an article stored with a full address', async () => {
      expect(await sourceUriOf(FEED)).toBe('https://feeds.example.test/rss');
    });

    it('serves a plain address unchanged and never the raw text of an unparseable value', async () => {
      expect(await sourceUriOf('https://feeds.example.test/plain.xml')).toBe(
        'https://feeds.example.test/plain.xml',
      );
      expect(await sourceUriOf('not a url ?key=zq7')).toBe(
        '(address withheld)',
      );
    });
  });

  describe('in open mode', () => {
    let api: NewsApi;
    beforeAll(async () => {
      api = await bootNewsApi({
        env: {
          MERA_NEWS_API_KEY: '',
          NEWS_API_OPEN: 'true',
          NEWS_API_OPEN_RATE_LIMIT: '1000',
        },
      });
    });
    afterAll(() => api.close());

    it('returns origin plus path and no fetch error on every path that returns a source', async () => {
      const sources = await allSources(api, null);

      expect(sources).toHaveLength(4);
      for (const s of sources) {
        expect(same(s.feed_url, 'https://feeds.example.test/rss')).toBe(true);
        expect(same(s.publication_url, 'https://www.example.test/home')).toBe(
          true,
        );
        expect(s.last_fetch_error).toBeNull();
      }
    });
  });

  describe('with a key', () => {
    let api: NewsApi;
    beforeAll(async () => {
      api = await bootNewsApi();
    });
    afterAll(() => api.close());

    it('returns the same redacted sources to a key holder', async () => {
      const sources = await allSources(api, 'news-api-test-key');

      expect(sources).toHaveLength(4);
      for (const s of sources) {
        expect(same(s.feed_url, 'https://feeds.example.test/rss')).toBe(true);
        expect(same(s.publication_url, 'https://www.example.test/home')).toBe(
          true,
        );
        expect(s.last_fetch_error).toBeNull();
      }
    });
  });
});

describe('news API query limits', () => {
  const deep = (levels: number) =>
    `{ ${'a { '.repeat(levels - 1)}a${' }'.repeat(levels - 1)} }`;

  describe('with the default limits', () => {
    let api: NewsApi;
    beforeAll(async () => {
      api = await bootNewsApi();
    });
    afterAll(() => api.close());

    it('refuses a query 13 levels deep', async () => {
      const res = await api.gql(deep(13));
      expect(
        res.body.errors?.some(
          (e) => e.extensions?.code === 'QUERY_TOO_COMPLEX',
        ),
      ).toBe(true);
    });

    it('refuses more than 1000 field selections', async () => {
      const fields = Array.from(
        { length: 1001 },
        (_, i) => `f${i}: allCountries`,
      );
      const res = await api.gql(`{ ${fields.join(' ')} }`);
      expect(res.body.errors?.[0].extensions?.code).toBe('QUERY_TOO_COMPLEX');
      expect(res.body.data ?? null).toBeNull();
    });

    it('answers the full introspection query in production mode', async () => {
      // A client learns what a server offers by introspection.
      const res = await api.gql<{ __schema: { queryType: { name: string } } }>(
        getIntrospectionQuery(),
      );
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data!.__schema.queryType.name).toBe('Query');
    });
  });

  describe('with NEWS_API_MAX_QUERY_DEPTH=3', () => {
    let api: NewsApi;
    beforeAll(async () => {
      api = await bootNewsApi({ env: { NEWS_API_MAX_QUERY_DEPTH: '3' } });
    });
    afterAll(() => api.close());

    it('refuses a valid query one level too deep before any resolver runs', async () => {
      const res = await api.gql(
        '{ articlesForCountry(countryCode: "NLD") { articles { publicationSource { _id } } } }',
      );
      expect(res.body.errors?.[0].extensions?.code).toBe('QUERY_TOO_COMPLEX');
      expect(res.body.data ?? null).toBeNull();
    });

    it('accepts a query at the limit', async () => {
      const res = await api.gql(
        '{ articlesForCountry(countryCode: "NLD") { articles { _id } } }',
      );
      expect(res.body.errors).toBeUndefined();
    });
  });
});
