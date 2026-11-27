import { QueueName } from '@mera/shared';
import { bootAsyncApp, type Harness } from '../../../harness/boot';
import {
  seedArticle,
  seedCluster,
  seedPublisher,
  seedSource,
} from '../support/fixtures';

type Card = { articleId: unknown; lang?: string; score?: number };
type RawEdition = {
  entries: { articleId: { toString(): string }; cards?: Card[] }[];
  views: { entries: { cards?: Card[] }[] }[];
};

describe('headline edition cards', () => {
  jest.setTimeout(60_000);
  let h: Harness;

  beforeAll(async () => {
    h = await bootAsyncApp();
  });
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(() => h.resetDb());

  it('stores one card per language with the publisher score, falling back through the language fields', async () => {
    const p1 = await seedPublisher(h.connection, { readingScore: 92 });
    const p2 = await seedPublisher(h.connection);
    const s1 = await seedSource(h.connection, {
      newsPublisherId: p1,
      feed_language_code: 'en-GB',
    });
    const s2 = await seedSource(h.connection, {
      newsPublisherId: p2,
      feed_language_code: 'fr',
    });
    const s3 = await seedSource(h.connection, {
      newsPublisherId: p1,
      feed_language_code: 'en',
      detected_language_code: 'hi',
    });
    const s4 = await seedSource(h.connection, { feed_language_code: 'nl' });
    const a1 = await seedArticle(h.connection, { source: s1 });
    const a2 = await seedArticle(h.connection, { source: s2 });
    const a3 = await seedArticle(h.connection, { source: s3 });
    const a4 = await seedArticle(h.connection, {
      source: s1,
      overrides: { original_language_code: 'de' },
    });
    const a5 = await seedArticle(h.connection, { source: s4 });
    await seedCluster(h.connection, [a1, a2, a3, a4, a5]);

    await h.runJob(QueueName.BUILD_HEADLINE_EDITIONS, {});

    const edition = (await h.connection
      .collection('headline-edition')
      .findOne({ scopeKey: 'NLD' })) as unknown as RawEdition;
    expect(edition.entries).toHaveLength(1);
    const cards = edition.entries[0].cards!;
    const byLang = new Map(cards.map((c) => [c.lang, c]));
    expect(cards).toHaveLength(5);
    expect(byLang.get('en')?.score).toBe(92);
    expect(byLang.get('hi')?.score).toBe(92);
    expect(byLang.get('de')?.score).toBe(92);
    expect(byLang.get('fr')).toBeDefined();
    expect(byLang.get('fr')).not.toHaveProperty('score');
    expect(byLang.get('nl')).toBeDefined();
    expect(byLang.get('nl')).not.toHaveProperty('score');
    for (const view of edition.views) {
      for (const entry of view.entries) expect(entry.cards).toBeDefined();
    }
    // No article has an image, so the representative is the newest one.
    expect(edition.entries[0].articleId.toString()).toBe(a5.toString());
  });
});
