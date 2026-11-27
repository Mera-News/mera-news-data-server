import { Types } from 'mongoose';
import { CLIENT_DOCUMENTS } from '../../../../apps/mera-server-news-api/src/modules/client-documents';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import {
  hoursAgo,
  seedArticle,
  seedHeadlineEdition,
  seedSource,
  seedTopic,
  seedTopicLink,
} from '../support/fixtures';

type Headlines = {
  worldHeadlines: {
    headlines: { article: { _id: string; source_uri: string } }[];
    facets: { topicId: string; count: number }[];
    editionBuiltAt: string | null;
    unavailableReason: string | null;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

const READ =
  'query($c: String, $first: Int, $after: String, $w: Int, $ids: [ID!]) { worldHeadlines(countryCode: $c, first: $first, after: $after, windowHours: $w, canonicalTopicIds: $ids) { headlines { article { _id source_uri } } facets { topicId count } editionBuiltAt unavailableReason pageInfo { hasNextPage endCursor } } }';

const idOf = (id: Types.ObjectId) => String(id);
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value), 'utf-8').toString('base64');

describe('world headlines', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());
  beforeEach(() => api.resetDb());

  const read = (variables: Record<string, unknown>) =>
    api.gql<Headlines>(READ, variables);

  async function canonical(path: string) {
    return seedTopic(api.connection, `cat:${path}`, {
      is_canonical: true,
      canonical_path: path,
      canonical_level: path.split('/').length - 1,
    });
  }

  /** An edition of two articles, one linked to Sports and one to Finance. */
  async function seedEdition(feedUrl?: string) {
    const source = await seedSource(
      api.connection,
      feedUrl ? { feed_url: feedUrl } : {},
    );
    const a = await seedArticle(api.connection, { source });
    const b = await seedArticle(api.connection, { source });
    await seedHeadlineEdition(api.connection, 'GLOBAL', [a, b]);
    const sports = await canonical('/Sports');
    const finance = await canonical('/Finance');
    await seedTopicLink(api.connection, sports, a, 0.9);
    await seedTopicLink(api.connection, finance, b, 0.9);
    return { a, b, sports, finance };
  }

  it('filters an edition with two entries to the linked one', async () => {
    const { a, sports } = await seedEdition();
    const res = await read({ c: 'GLOBAL', ids: [idOf(sports)] });
    expect(res.body.errors).toBeUndefined();
    const page = res.body.data!.worldHeadlines;
    expect(page.headlines.map((h) => h.article._id)).toEqual([idOf(a)]);
    expect(page.unavailableReason).toBeNull();
    expect(page.editionBuiltAt).not.toBeNull();
  });

  it('counts facets over the whole edition, ignoring the filter', async () => {
    const { sports, finance } = await seedEdition();
    const res = await read({ c: 'GLOBAL', ids: [idOf(sports)] });
    const facets = res.body.data!.worldHeadlines.facets;
    expect(facets.map((f) => [f.topicId, f.count]).sort()).toEqual(
      [
        [idOf(sports), 1],
        [idOf(finance), 1],
      ].sort(),
    );
  });

  it('serves the whole edition with a null reason when no filter is sent', async () => {
    await seedEdition();
    const res = await read({ c: 'GLOBAL' });
    const page = res.body.data!.worldHeadlines;
    expect(page.headlines).toHaveLength(2);
    expect(page.unavailableReason).toBeNull();
  });

  it('answers NO_EDITION for a filter when no edition exists', async () => {
    const res = await read({ c: 'GLOBAL', ids: [idOf(new Types.ObjectId())] });
    expect(res.body.errors).toBeUndefined();
    const page = res.body.data!.worldHeadlines;
    expect(page.headlines).toEqual([]);
    expect(page.unavailableReason).toBe('NO_EDITION');
  });

  it('answers NO_CANONICAL_TOPICS for a filter when no canonical rows exist', async () => {
    const source = await seedSource(api.connection);
    const a = await seedArticle(api.connection, { source });
    await seedHeadlineEdition(api.connection, 'GLOBAL', [a]);
    const res = await read({ c: 'GLOBAL', ids: [idOf(new Types.ObjectId())] });
    const page = res.body.data!.worldHeadlines;
    expect(page.headlines).toEqual([]);
    expect(page.unavailableReason).toBe('NO_CANONICAL_TOPICS');
  });

  it('answers NO_TOPIC_LINKS for a filter when no link joins the edition to a canonical row, and never the unfiltered list', async () => {
    const source = await seedSource(api.connection);
    const a = await seedArticle(api.connection, { source });
    const b = await seedArticle(api.connection, { source });
    await seedHeadlineEdition(api.connection, 'GLOBAL', [a, b]);
    const sports = await canonical('/Sports');
    // A link from another article, outside the edition, joins nothing in it.
    const other = await seedArticle(api.connection, { source });
    await seedTopicLink(api.connection, sports, other, 0.9);

    const filtered = await read({ c: 'GLOBAL', ids: [idOf(sports)] });
    const page = filtered.body.data!.worldHeadlines;
    expect(page.headlines).toEqual([]);
    expect(page.unavailableReason).toBe('NO_TOPIC_LINKS');

    const plain = await read({ c: 'GLOBAL' });
    expect(plain.body.data!.worldHeadlines.headlines).toHaveLength(2);
    expect(plain.body.data!.worldHeadlines.unavailableReason).toBeNull();
  });

  it('serves the live fallback with no reason when there is no filter and no edition', async () => {
    const source = await seedSource(api.connection, { country_code: 'NLD' });
    const a = await seedArticle(api.connection, {
      source,
      createdAt: hoursAgo(1),
    });
    const res = await read({ c: 'NLD' });
    expect(res.body.errors).toBeUndefined();
    const page = res.body.data!.worldHeadlines;
    expect(page.headlines.map((h) => h.article._id)).toEqual([idOf(a)]);
    expect(page.editionBuiltAt).toBeNull();
    expect(page.facets).toEqual([]);
    expect(page.unavailableReason).toBeNull();
  });

  it('pages an edition by the cursor it returns', async () => {
    const { a, b } = await seedEdition();
    const first = await read({ c: 'GLOBAL', first: 1 });
    const one = first.body.data!.worldHeadlines;
    expect(one.headlines.map((h) => h.article._id)).toEqual([idOf(a)]);
    expect(one.pageInfo.hasNextPage).toBe(true);
    const second = await read({
      c: 'GLOBAL',
      first: 1,
      after: one.pageInfo.endCursor,
    });
    expect(
      second.body.data!.worldHeadlines.headlines.map((h) => h.article._id),
    ).toEqual([idOf(b)]);
  });

  it('serves addresses without their secrets', async () => {
    await seedEdition('https://u:p@feeds.example.test/rss?token=zq9secret');
    const res = await read({ c: 'GLOBAL' });
    const page = res.body.data!.worldHeadlines;
    // The resolver ran: both entries came back.
    expect(page.headlines).toHaveLength(2);
    const text = JSON.stringify(res.body);
    expect(text.includes('zq9secret')).toBe(false);
    expect(text.includes('u:p@')).toBe(false);
  });

  describe('caps', () => {
    const hex = () => idOf(new Types.ObjectId());

    it('refuses 51 topic ids and accepts 50', async () => {
      const over = await read({
        c: 'GLOBAL',
        ids: Array.from({ length: 51 }, hex),
      });
      expect(over.body.errors?.[0].message).toMatch(/50/);
      expect(over.body.data ?? null).toBeNull();
      const at = await read({
        c: 'GLOBAL',
        ids: Array.from({ length: 50 }, hex),
      });
      expect(at.body.errors).toBeUndefined();
    });

    it.each(['not-an-id', 'z'.repeat(24), 'a'.repeat(25)])(
      'refuses the topic id %s',
      async (id) => {
        const res = await read({ c: 'GLOBAL', ids: [id] });
        expect(res.body.errors?.[0].message).toMatch(/24/);
      },
    );

    it('refuses a country code over 8 characters', async () => {
      const res = await read({ c: 'ABCDEFGHI' });
      expect(res.body.errors?.[0].message).toMatch(/8/);
    });

    it('refuses a window outside 6, 12, 24 and 48', async () => {
      const res = await read({ c: 'GLOBAL', w: 7 });
      expect(res.body.errors?.[0].extensions?.code).toBe('BAD_WINDOW');
    });

    it.each([
      ['0', 0, 1],
      ['a negative number', -5, 1],
      ['a huge number', 1_000_000, 50],
    ])('clamps first given %s', async (_, first, pageSize) => {
      await seedEdition();
      const res = await api.gql<{
        worldHeadlines: { pageInfo: { pageSize: number } };
      }>(
        'query($first: Int) { worldHeadlines(countryCode: "GLOBAL", first: $first) { pageInfo { pageSize } } }',
        { first },
      );
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data!.worldHeadlines.pageInfo.pageSize).toBe(pageSize);
    });

    it('refuses a malformed offset cursor on topHeadlinesForCountry too', async () => {
      const res = await api.gql(
        `{ topHeadlinesForCountry(countryCode: "GLOBAL", after: ${JSON.stringify(encode({ offset: -1 }))}) { pageInfo { hasNextPage } } }`,
      );
      expect(res.body.errors?.[0].message).toBe('after is not a valid cursor');
    });

    it('refuses a cursor over 512 characters', async () => {
      const res = await read({ c: 'GLOBAL', after: 'a'.repeat(513) });
      expect(res.body.errors?.[0].message).toMatch(/512/);
    });

    it.each([
      ['text that is not base64 JSON', 'not a cursor'],
      ['JSON without an offset', encode({ page: 2 })],
      ['a negative offset', encode({ offset: -1 })],
      ['a fractional offset', encode({ offset: 1.5 })],
      ['a text offset', encode({ offset: '1' })],
      ['a bare number', encode(7)],
    ])('refuses a cursor that is %s, never a first page', async (_, after) => {
      await seedEdition();
      const res = await read({ c: 'GLOBAL', first: 1, after });
      expect(res.body.errors?.[0].message).toBe('after is not a valid cursor');
      expect(res.body.data ?? null).toBeNull();
    });
  });
});

describe('query limits on world headlines', () => {
  let api: NewsApi;
  beforeAll(async () => {
    api = await bootNewsApi({ env: { NEWS_API_MAX_QUERY_DEPTH: '3' } });
  });
  afterAll(() => api.close());

  it('refuses the field one level too deep before any resolver runs', async () => {
    const res = await api.gql(
      '{ worldHeadlines { headlines { article { _id } } } }',
    );
    expect(res.body.errors?.[0].extensions?.code).toBe('QUERY_TOO_COMPLEX');
    expect(res.body.data ?? null).toBeNull();
  });

  it('refuses many aliases of the field in one query', async () => {
    const aliases = Array.from(
      { length: 1001 },
      (_, i) => `a${i}: worldHeadlines { unavailableReason }`,
    ).join(' ');
    const res = await api.gql(`{ ${aliases} }`);
    expect(res.body.errors?.[0].extensions?.code).toBe('QUERY_TOO_COMPLEX');
  });

  it('accepts the field at the limit and runs the resolver', async () => {
    await api.resetDb();
    const source = await seedSource(api.connection);
    const a = await seedArticle(api.connection, { source });
    await seedHeadlineEdition(api.connection, 'GLOBAL', [a]);
    const sports = await seedTopic(api.connection, 'cat:/Sports', {
      is_canonical: true,
      canonical_path: '/Sports',
      canonical_level: 1,
    });
    await seedTopicLink(api.connection, sports, a, 0.9);

    const res = await api.gql<{
      worldHeadlines: {
        headlines: { clusterSize: number }[];
        unavailableReason: string | null;
      };
    }>(
      `{ worldHeadlines(countryCode: "GLOBAL", canonicalTopicIds: ["${String(sports)}"]) { headlines { clusterSize } unavailableReason } }`,
    );
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.worldHeadlines.headlines).toHaveLength(1);
    expect(res.body.data!.worldHeadlines.unavailableReason).toBeNull();
  });
});

describe('the client document for world headlines', () => {
  let api: NewsApi;
  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());

  it('is answered by the served schema', async () => {
    await api.resetDb();
    const res = await api.gql<Headlines>(CLIENT_DOCUMENTS.GetWorldHeadlines, {
      countryCode: 'GLOBAL',
      first: 5,
      windowHours: 24,
      canonicalTopicIds: [],
    });
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.worldHeadlines.facets).toEqual([]);
  });
});

describe('world headlines for a reader language', () => {
  let api: NewsApi;
  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());
  beforeEach(() => api.resetDb());

  const QUERY =
    'query($first: Int, $after: String, $lang: String, $ids: [ID!]) { worldHeadlines(countryCode: "GLOBAL", first: $first, after: $after, language: $lang, canonicalTopicIds: $ids) { headlines { article { _id } } facets { topicId count } pageInfo { hasNextPage endCursor } } }';
  const read = (variables: Record<string, unknown> = {}) =>
    api.gql<Headlines>(QUERY, variables);
  const shown = (res: Awaited<ReturnType<typeof read>>) => {
    expect(res.body.errors).toBeUndefined();
    return res.body.data!.worldHeadlines.headlines.map((h) => h.article._id);
  };

  async function article(): Promise<Types.ObjectId> {
    const source = await seedSource(api.connection);
    return seedArticle(api.connection, { source });
  }
  const card = (articleId: Types.ObjectId, lang?: string, score?: number) => ({
    articleId,
    ...(lang ? { lang } : {}),
    ...(score !== undefined ? { score } : {}),
  });
  const entry = (
    articleId: Types.ObjectId,
    cards: ReturnType<typeof card>[],
  ) => ({ articleId, cards });

  it('keeps the stored order and reports without a language', async () => {
    const [a, b, c, d] = [
      await article(),
      await article(),
      await article(),
      await article(),
    ];
    await seedHeadlineEdition(api.connection, 'GLOBAL', [
      entry(a, [card(a, 'en', 40), card(d, 'fr', 90)]),
      entry(b, [card(b, 'de', 100)]),
      entry(c, [card(c, 'fr', 60)]),
    ]);
    expect(shown(await read())).toEqual([a, b, c].map(idOf));
  });

  it('shows the reader-language card of a story', async () => {
    const aEn = await article();
    const aFr = await article();
    await seedHeadlineEdition(api.connection, 'GLOBAL', [
      entry(aEn, [card(aEn, 'en', 40), card(aFr, 'fr', 90)]),
    ]);
    expect(shown(await read({ lang: 'fr' }))).toEqual([idOf(aFr)]);
  });

  it('partitions the reader-language stories first and never sorts by score', async () => {
    const [big, other, fr, low] = [
      await article(),
      await article(),
      await article(),
      await article(),
    ];
    await seedHeadlineEdition(api.connection, 'GLOBAL', [
      entry(big, [card(big, 'en', 10)]),
      entry(other, [card(other, 'de', 100)]),
      entry(fr, [card(fr, 'fr', 60)]),
      entry(low, [card(low, 'fr', 40)]),
    ]);
    expect(shown(await read({ lang: 'fr' }))).toEqual(
      [fr, big, other, low].map(idOf),
    );
  });

  it('a reader-language card under 50 loses the card and gets no head start', async () => {
    const [first, r, o] = [await article(), await article(), await article()];
    await seedHeadlineEdition(api.connection, 'GLOBAL', [
      entry(first, [card(first, 'en', 20)]),
      entry(r, [card(r, 'fr', 45), card(o, 'en', 70)]),
    ]);
    expect(shown(await read({ lang: 'fr' }))).toEqual([first, o].map(idOf));
  });

  it('a reader-language card at 50 or more beats a score of 100 and leads', async () => {
    const [first, o, r] = [await article(), await article(), await article()];
    await seedHeadlineEdition(api.connection, 'GLOBAL', [
      entry(first, [card(first, 'en', 20)]),
      entry(o, [card(o, 'en', 100), card(r, 'fr', 50)]),
    ]);
    expect(shown(await read({ lang: 'fr' }))).toEqual([r, first].map(idOf));
  });

  it('serves the request without a language when nothing is scored', async () => {
    const [a, b, c] = [await article(), await article(), await article()];
    await seedHeadlineEdition(api.connection, 'GLOBAL', [
      entry(a, [card(a, 'en'), card(c, 'fr')]),
      entry(b, [card(b, 'en')]),
    ]);
    expect(shown(await read({ lang: 'fr' }))).toEqual(shown(await read()));
  });

  it('serves a legacy edition without cards as it is', async () => {
    const [a, b] = [await article(), await article()];
    await seedHeadlineEdition(api.connection, 'GLOBAL', [a, b]);
    expect(shown(await read({ lang: 'en' }))).toEqual(shown(await read()));
  });

  it('filters and counts facets on the stored article, then shows the card', async () => {
    const [stored, frCard, other] = [
      await article(),
      await article(),
      await article(),
    ];
    await seedHeadlineEdition(api.connection, 'GLOBAL', [
      entry(stored, [card(stored, 'en', 10), card(frCard, 'fr', 80)]),
      entry(other, [card(other, 'en', 10)]),
    ]);
    const topic = await seedTopic(api.connection, 'cat:/Sports', {
      is_canonical: true,
      canonical_path: '/Sports',
      canonical_level: 1,
    });
    await seedTopicLink(api.connection, topic, stored, 0.9);
    const filtered = await read({ lang: 'fr', ids: [idOf(topic)] });
    expect(shown(filtered)).toEqual([idOf(frCard)]);
    const plain = await read({ ids: [idOf(topic)] });
    expect(filtered.body.data!.worldHeadlines.facets).toEqual(
      plain.body.data!.worldHeadlines.facets,
    );
    expect(plain.body.data!.worldHeadlines.facets).toHaveLength(1);
  });

  it('pages over the reordered stories without repeats', async () => {
    const ids = [
      await article(),
      await article(),
      await article(),
      await article(),
    ];
    await seedHeadlineEdition(api.connection, 'GLOBAL', [
      entry(ids[0], [card(ids[0], 'en', 80)]),
      entry(ids[1], [card(ids[1], 'en', 80)]),
      entry(ids[2], [card(ids[2], 'fr', 80)]),
      entry(ids[3], [card(ids[3], 'fr', 80)]),
    ]);
    const one = await read({ lang: 'fr', first: 2 });
    expect(shown(one)).toEqual([ids[2], ids[3]].map(idOf));
    expect(one.body.data!.worldHeadlines.pageInfo.hasNextPage).toBe(true);
    const two = await read({
      lang: 'fr',
      first: 2,
      after: one.body.data!.worldHeadlines.pageInfo.endCursor,
    });
    expect(shown(two)).toEqual([ids[0], ids[1]].map(idOf));
    expect(two.body.data!.worldHeadlines.pageInfo.hasNextPage).toBe(false);
  });

  it('rejects a language that is not a base tag and treats empty as absent', async () => {
    const [a, b] = [await article(), await article()];
    await seedHeadlineEdition(api.connection, 'GLOBAL', [
      entry(a, [card(a, 'en', 10)]),
      entry(b, [card(b, 'fr', 90)]),
    ]);
    const bad = await read({ lang: 'english' });
    expect(bad.body.errors?.[0].extensions?.code).toBe('BAD_REQUEST');
    expect(shown(await read({ lang: '' }))).toEqual(shown(await read()));
  });
});
