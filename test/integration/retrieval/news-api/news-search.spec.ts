import { createHmac } from 'crypto';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import type { Cache } from 'cache-manager';
import {
  EMBEDDING_PROVIDER,
  FakeEmbeddingProvider,
  NewsSearchService,
  type EmbeddingProvider,
} from '@mera/news-core';
import {
  API_KEY_VERIFIER,
  OpenApiKeyVerifier,
} from '../../../../apps/mera-server-news-api/src/guards/api-key.guard';
import { installAtlasSearchFake } from '../../../harness/atlas-search-fake';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import { seedArticle, seedSource } from '../support/fixtures';

type Hits = {
  searchNews: {
    _id: string;
    title_en: string;
    publication_name: string | null;
    score: number;
  }[];
};

const SEARCH =
  'query($q: String!, $limit: Int) { searchNews(query: $q, limit: $limit) { _id title_en publication_name score } }';

/** The fake provider, with a record of every text it was asked to embed. */
class RecordingEmbedder implements EmbeddingProvider {
  readonly calls: string[][] = [];
  private readonly inner = new FakeEmbeddingProvider();
  embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts);
    return this.inner.embed(texts);
  }
}

/** A vector the search embeds `query` to, so an article carrying it scores 1. */
const vectorFor = (query: string) => FakeEmbeddingProvider.vectorFor(query);

const hmac = (secret: string, text: string) =>
  createHmac('sha256', secret).update(text.toLowerCase()).digest('hex');

/** Every key and value in every store of the cache, as text. */
async function cacheEntries(api: NewsApi): Promise<[string, string][]> {
  const cache = api.app.get<Cache>(CACHE_MANAGER);
  const entries: [string, string][] = [];
  for (const store of cache.stores) {
    for await (const [key, value] of store.iterator!(undefined)) {
      entries.push([String(key), JSON.stringify(value)]);
    }
  }
  return entries;
}

describe('news search', () => {
  let api: NewsApi;
  let embedder: RecordingEmbedder;
  const booted: NewsApi[] = [];
  let fake: ReturnType<typeof installAtlasSearchFake> | undefined;

  const boot = async (env: Record<string, string> = {}) => {
    embedder = new RecordingEmbedder();
    api = await bootNewsApi({
      env,
      override: (b) =>
        b.overrideProvider(EMBEDDING_PROVIDER).useValue(embedder),
    });
    booted.push(api);
  };
  const search = (q: string, limit?: number | null) =>
    api.gql<Hits>(SEARCH, { q, limit });

  afterEach(async () => {
    fake?.uninstall();
    fake = undefined;
    // Last booted first: each boot restores the env it found.
    while (booted.length > 0) await booted.pop()!.close();
  });

  describe('with the vector index and no text index', () => {
    beforeEach(async () => {
      fake = installAtlasSearchFake();
      await boot({ SEARCH_CACHE_SECRET: 'search-test-secret' });
      await api.resetDb();
    });

    it('answers a matching article from the vector leg alone', async () => {
      const source = await seedSource(api.connection);
      const match = await seedArticle(api.connection, {
        source,
        vector: vectorFor('harbour tram line'),
      });
      await seedArticle(api.connection, {
        source,
        vector: vectorFor('something unrelated'),
      });

      const res = await search('harbour tram line');

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data!.searchNews.map((h) => h._id)).toEqual([
        String(match),
      ]);
      expect(res.body.data!.searchNews[0].publication_name).toMatch(
        /^Example Daily/,
      );
    });

    it('refuses a 201 character query before any embedding call, without echoing it', async () => {
      const long = 'q'.repeat(201);
      const res = await search(long);

      expect(res.body.errors?.[0].extensions?.code).toBe('QUERY_TOO_LONG');
      expect(res.body.errors?.[0].message).not.toContain('qqqqq');
      expect(embedder.calls).toEqual([]);
    });

    it('measures the cap after normalising, so 200 characters pass', async () => {
      const res = await search(`  ${'q'.repeat(200)}  `);

      expect(res.body.errors).toBeUndefined();
      expect(embedder.calls).toHaveLength(1);
    });

    it('keys the embedding cache by an HMAC of the query and never holds the text', async () => {
      const marker = 'zq7cachemarker';
      const source = await seedSource(api.connection);
      await seedArticle(api.connection, {
        source,
        vector: vectorFor(`Water ${marker}`),
      });

      const res = await search(`  Water   ${marker} `);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data!.searchNews).toHaveLength(1);

      const entries = await cacheEntries(api);
      const keys = entries
        .map(([key]) => key)
        .filter((k) => k.includes('news-search'));
      expect(keys).toEqual([
        `news-search-embed:k:${hmac('search-test-secret', `Water ${marker}`)}`,
      ]);
      expect(keys[0]).toMatch(/^news-search-embed:k:[0-9a-f]{64}$/);
      for (const [key, value] of entries) {
        expect(key.toLowerCase()).not.toContain(marker);
        expect(value.toLowerCase()).not.toContain(marker);
      }
      const collections = await api.connection.db!.collections();
      for (const collection of collections) {
        const docs = await collection.find({}).toArray();
        expect(JSON.stringify(docs).toLowerCase()).not.toContain(marker);
      }
    });

    it('clamps the limit to 1 to 25 in the resolver', async () => {
      const source = await seedSource(api.connection);
      for (let i = 0; i < 30; i++) {
        await seedArticle(api.connection, {
          source,
          vector: vectorFor('crowded topic'),
        });
      }
      const count = async (limit: number | null) => {
        const res = await search('crowded topic', limit);
        expect(res.body.errors).toBeUndefined();
        return res.body.data!.searchNews.length;
      };

      expect(await count(0)).toBe(1);
      expect(await count(-4)).toBe(1);
      expect(await count(100000)).toBe(25);
      expect(await count(null)).toBe(20);
    });

    it('serves only the pinned hit fields, none of them an address', async () => {
      const res = await api.gql<{
        __type: { fields: { name: string }[] };
      }>('{ __type(name: "NewsSearchHit") { fields { name } } }');

      expect(res.body.data!.__type.fields.map((f) => f.name).sort()).toEqual([
        '_id',
        'country_code',
        'image_url',
        'pubDate',
        'publication_name',
        'score',
        'title_en',
      ]);
    });

    it('serves no feed address or token from the source', async () => {
      const source = await seedSource(api.connection, {
        feed_url: 'https://reader:hunter2@example.test/feed.xml?key=tok3n9',
      });
      await seedArticle(api.connection, {
        source,
        vector: vectorFor('redaction topic'),
      });

      const res = await api.gql(
        'query($q: String!) { searchNews(query: $q) { _id title_en image_url publication_name country_code pubDate score } }',
        {
          q: 'redaction topic',
        },
      );

      expect(res.body.errors).toBeUndefined();
      const text = JSON.stringify(res.body);
      expect(text).toContain('Example headline');
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('tok3n9');
    });

    it('refuses a request without a key', async () => {
      const res = await api.gql(SEARCH, { q: 'anything' }, null);

      expect(res.status).toBe(200);
      expect(res.body.errors?.[0].message).toBe('Invalid API key');
      expect(embedder.calls).toEqual([]);
    });
  });

  it('keeps the cache per process when no secret is set', async () => {
    fake = installAtlasSearchFake();
    const keyOf = async () => {
      await boot({ SEARCH_CACHE_SECRET: '' });
      const res = await search('same query');
      expect(res.body.errors).toBeUndefined();
      const [key] = (await cacheEntries(api))
        .map(([k]) => k)
        .filter((k) => k.includes('news-search'));
      return key;
    };

    const first = await keyOf();
    const second = await keyOf();

    expect(first).toMatch(/^news-search-embed:k:[0-9a-f]{64}$/);
    expect(second).toMatch(/^news-search-embed:k:[0-9a-f]{64}$/);
    expect(first).not.toEqual(second);
    expect(first).not.toContain('same');
  });

  it.each<Record<string, string>>([{}, { NEWS_API_SEARCH_OPEN: 'true' }])(
    'is not offered in open mode (%j) and embeds nothing',
    async (extra) => {
      fake = installAtlasSearchFake();
      await boot({ NEWS_API_OPEN: 'true', ...extra });

      const res = await search('harbour tram line');

      expect(res.body.errors?.[0].extensions?.code).toBe('SEARCH_NOT_OFFERED');
      expect(embedder.calls).toEqual([]);
    },
  );

  it('offers search to a custom key verifier, the way a deployment binds its own', async () => {
    fake = installAtlasSearchFake();
    embedder = new RecordingEmbedder();
    api = await bootNewsApi({
      override: (b) =>
        b
          .overrideProvider(EMBEDDING_PROVIDER)
          .useValue(embedder)
          .overrideProvider(API_KEY_VERIFIER)
          .useValue({
            verify: (presented?: string) =>
              Promise.resolve(presented === 'custom-key' ? 'custom' : null),
          }),
    });
    booted.push(api);

    const res = await api.gql<Hits>(SEARCH, { q: 'harbour' }, 'custom-key');

    expect(res.body.errors).toBeUndefined();
    expect(embedder.calls).toHaveLength(1);
  });

  it('refuses search in open mode even behind a wrapping verifier', async () => {
    fake = installAtlasSearchFake();
    embedder = new RecordingEmbedder();
    const open = new OpenApiKeyVerifier();
    api = await bootNewsApi({
      env: { NEWS_API_OPEN: 'true', MERA_NEWS_API_KEY: '' },
      override: (b) =>
        b
          .overrideProvider(EMBEDDING_PROVIDER)
          .useValue(embedder)
          .overrideProvider(API_KEY_VERIFIER)
          .useValue({ verify: () => open.verify() }),
    });
    booted.push(api);

    const res = await api.gql<Hits>(SEARCH, { q: 'harbour' }, null);

    expect(res.body.errors?.[0].extensions?.code).toBe('SEARCH_NOT_OFFERED');
    expect(embedder.calls).toEqual([]);
  });

  it('refuses an invalid SEARCH_VECTOR_MIN_SCORE when built, naming the key and not the value', () => {
    for (const value of ['abc', '0', '1.5', '-0.2']) {
      const build = () =>
        new NewsSearchService(
          null as never,
          null as never,
          null as never,
          null as never,
          null as never,
          new ConfigService({ SEARCH_VECTOR_MIN_SCORE: value }),
        );
      // The exact text: the key and the rule, never the configured value.
      expect(build).toThrow(
        /^SEARCH_VECTOR_MIN_SCORE must be a number above 0 and at most 1$/,
      );
    }
  });

  it('answers SEARCH_UNAVAILABLE, not a server error, when neither index exists', async () => {
    await boot();
    await api.resetDb();
    const source = await seedSource(api.connection);
    await seedArticle(api.connection, {
      source,
      vector: vectorFor('harbour tram line'),
    });

    const res = await search('harbour tram line');

    expect(res.status).toBe(200);
    expect(res.body.errors?.[0].extensions?.code).toBe('SEARCH_UNAVAILABLE');
    expect(res.body.errors?.[0].message).not.toContain('harbour');
  });

  describe('query limits', () => {
    it('refuses the hit one level too deep before any resolver runs', async () => {
      await boot({ NEWS_API_MAX_QUERY_DEPTH: '1' });

      const res = await api.gql('{ searchNews(query: "x") { _id } }');

      expect(res.body.errors?.[0].extensions?.code).toBe('QUERY_TOO_COMPLEX');
      expect(embedder.calls).toEqual([]);
    });

    it('refuses many aliases of the field in one query', async () => {
      await boot();
      const aliases = Array.from(
        { length: 1001 },
        (_, i) => `a${i}: searchNews(query: "x") { _id }`,
      ).join(' ');

      const res = await api.gql(`{ ${aliases} }`);

      expect(res.body.errors?.[0].extensions?.code).toBe('QUERY_TOO_COMPLEX');
      expect(embedder.calls).toEqual([]);
    });

    it('accepts the field at the limit and runs the resolver', async () => {
      fake = installAtlasSearchFake();
      await boot({ NEWS_API_MAX_QUERY_DEPTH: '2' });
      await api.resetDb();
      const source = await seedSource(api.connection);
      const id = await seedArticle(api.connection, {
        source,
        vector: vectorFor('at the limit'),
      });

      const res = await api.gql<{ searchNews: { _id: string }[] }>(
        '{ searchNews(query: "at the limit") { _id } }',
      );

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data!.searchNews.map((h) => h._id)).toEqual([String(id)]);
    });
  });
});
