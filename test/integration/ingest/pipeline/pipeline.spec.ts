import { getModelToken } from '@nestjs/mongoose';
import { http, HttpResponse } from 'msw';
import type { Model } from 'mongoose';
import { QueueName } from '@mera/shared';
import { NewsArticle } from '@mera/models/models/news-article.model';
import { NewsPublisher } from '@mera/models/models/news-publisher.model';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import { bootAsyncApp, waitFor, type Harness } from '../../../harness/boot';
import { server, takeUnhandled } from '../../../harness/msw';

interface Item {
  title: string;
  description: string;
}

/** An RSS document whose items were published minutes ago, so no date is hardcoded. */
function feedXml(host: string, language: string, items: Item[]): string {
  const entries = items
    .map(
      (item, i) => `<item>
  <title>${item.title}</title>
  <link>https://${host}/story-${i}</link>
  <description>${item.description}</description>
  <pubDate>${new Date(Date.now() - (i + 1) * 60_000).toUTCString()}</pubDate>
</item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${host}</title><link>https://${host}/</link><description>Fixture feed</description>
<language>${language}</language>
${entries}
</channel></rss>`;
}

// English descriptions are longer than CLD3's 140-byte minimum, so the
// translate stage detects English and passes them through untranslated.
const ENGLISH: Item[] = [
  {
    title: 'Harbour council approves new ferry timetable',
    description:
      'The council voted on Tuesday to add two evening crossings to the island ferry, after a year of complaints from commuters who work late shifts on the mainland.',
  },
  {
    title: 'Library opens a seed exchange for gardeners',
    description:
      'Residents can borrow vegetable seeds from the central library and return a share of the seeds they harvest each autumn, so the collection grows every year.',
  },
];
const GERMAN: Item[] = [
  {
    title: 'Stadtrat beschliesst neuen Fahrplan fuer die Faehre',
    description:
      'Der Stadtrat hat am Dienstag zwei zusaetzliche Abendfahrten zur Insel beschlossen.',
  },
  {
    title: 'Bibliothek eroeffnet eine Saatgutboerse fuer Gaertner',
    description:
      'Anwohner koennen Gemuesesamen ausleihen und im Herbst geerntete Samen zurueckgeben.',
  },
];

// Each field is under CLD3's 140-byte minimum; the two joined are over it.
const SHORT_ENGLISH: Item = {
  title:
    'Harbour council approves a new ferry timetable for the island after a long debate',
  description:
    'The council voted on Tuesday to add two evening crossings to the island ferry service.',
};
const SHORT_FRENCH: Item = {
  title:
    'Le conseil municipal approuve un nouvel horaire pour le ferry de l\u2019\u00eele apr\u00e8s un long d\u00e9bat',
  description:
    'Le conseil a vot\u00e9 mardi pour ajouter deux travers\u00e9es en soir\u00e9e au service de ferry de l\u2019\u00eele.',
};

describe('ingest pipeline', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootAsyncApp();
  });
  afterAll(() => h.close());
  beforeEach(() => h.resetDb());

  it('carries every feed item from the fanout to a projected, embedded article', async () => {
    const model = <T>(name: string) =>
      h.app.get<Model<T>>(getModelToken(name), { strict: false });
    const publisher = await model<NewsPublisher>(NewsPublisher.name).create({
      name: 'Example Press',
      country_code: 'GBR',
      is_active: true,
    });
    const feeds = [
      { host: 'english.example.test', language: 'en', items: ENGLISH },
      { host: 'deutsch.example.test', language: 'de', items: GERMAN },
    ];
    for (const feed of feeds) {
      await model<PublicationSource>(PublicationSource.name).create({
        publication_name: feed.host,
        feed_url: `https://${feed.host}/rss.xml`,
        type: 'rss-feed',
        country_code: 'GBR',
        category: 'general',
        newsPublisherId: publisher._id,
      });
      server.use(
        http.get(`https://${feed.host}/rss.xml`, () =>
          HttpResponse.text(feedXml(feed.host, feed.language, feed.items), {
            headers: { 'content-type': 'application/rss+xml' },
          }),
        ),
      );
    }

    await h.runJob(QueueName.NEWS_SYNC_FANOUT, {});
    expect(h.queues[QueueName.LOAD_RSS_FEED].jobs).toHaveLength(feeds.length);
    for (const stage of [
      QueueName.LOAD_RSS_FEED,
      QueueName.TRANSLATE_ARTICLE,
      QueueName.GENERATE_EMBEDDING_ARTICLE,
      QueueName.DATABASE_PROJECTOR,
    ]) {
      expect(await h.drain(stage)).toBeGreaterThan(0);
    }

    const articles = model<NewsArticle>(NewsArticle.name);
    const expected = feeds.flatMap((f) =>
      f.items.map((_, i) => `https://${f.host}/story-${i}`),
    );
    const stored = await articles
      .find()
      .select('+embedding_article_data_retrieval')
      .lean();
    expect(stored.map((a) => a.article_url).sort()).toEqual(expected.sort());
    for (const article of stored) {
      expect(article.title_en_internal_only).toBeTruthy();
      expect(article.description_en_internal_only).toBeTruthy();
      expect(article.embedding_article_data_retrieval).toHaveLength(768);
      expect(article.copy_keys?.length).toBeGreaterThan(0);
      // The fake translator copies text, so the source field is what shows which
      // path an article took: German was translated, English passed through.
      const german = article.article_url.includes('deutsch.example.test');
      expect(article.embedding_text_source).toBe(
        german ? 'english_translation' : 'english_original',
      );
      // The story key is written after the projector returns, so wait for it.
      await waitFor(() =>
        articles.exists({
          _id: article._id,
          story_key: { $exists: true, $ne: '' },
        }),
      );
    }
  });

  /** Ingests one item from a fresh feed and returns the stored article. */
  async function ingestOne(host: string, language: string, item: Item) {
    const model = <T>(name: string) =>
      h.app.get<Model<T>>(getModelToken(name), { strict: false });
    const publisher = await model<NewsPublisher>(NewsPublisher.name).create({
      name: 'Example Press',
      country_code: 'GBR',
      is_active: true,
    });
    await model<PublicationSource>(PublicationSource.name).create({
      publication_name: host,
      feed_url: `https://${host}/rss.xml`,
      type: 'rss-feed',
      country_code: 'GBR',
      category: 'general',
      newsPublisherId: publisher._id,
    });
    server.use(
      http.get(`https://${host}/rss.xml`, () =>
        HttpResponse.text(feedXml(host, language, [item]), {
          headers: { 'content-type': 'application/rss+xml' },
        }),
      ),
    );
    await h.runJob(QueueName.NEWS_SYNC_FANOUT, {});
    for (const stage of [
      QueueName.LOAD_RSS_FEED,
      QueueName.TRANSLATE_ARTICLE,
      QueueName.GENERATE_EMBEDDING_ARTICLE,
      QueueName.DATABASE_PROJECTOR,
    ]) {
      await h.drain(stage);
    }
    return model<NewsArticle>(NewsArticle.name)
      .findOne({ article_url: `https://${host}/story-0` })
      .lean();
  }

  it('passes a short English item through untranslated when title and description together are long enough to detect', async () => {
    const article = await ingestOne(
      'short-en.example.test',
      'en',
      SHORT_ENGLISH,
    );
    expect(article?.embedding_text_source).toBe('english_original');
    expect(article?.translationSkipReason).toBe('Article is in English');
  });

  it('still translates a short French item of the same shape', async () => {
    const article = await ingestOne(
      'short-fr.example.test',
      'fr',
      SHORT_FRENCH,
    );
    expect(article?.embedding_text_source).toBe('english_translation');
    expect(article?.original_language_code).toBe('fr');
  });

  it('still translates an English item too short to detect even when joined', async () => {
    const article = await ingestOne('tiny-en.example.test', 'en', {
      title: 'Council approves ferry timetable',
      description: 'Two evening crossings added.',
    });
    expect(article?.embedding_text_source).toBe('english_translation');
  });
});

describe('translation provider choice', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ['TRANSLATION_PROVIDER', 'ARTICLE_ENRICHMENT_PROVIDER']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('TRANSLATION_PROVIDER=none keeps the article in its own language and calls no service', async () => {
    process.env.TRANSLATION_PROVIDER = 'none';
    const h = await bootAsyncApp();
    try {
      await h.resetDb();
      const model = <T>(name: string) =>
        h.app.get<Model<T>>(getModelToken(name), { strict: false });
      const publisher = await model<NewsPublisher>(NewsPublisher.name).create({
        name: 'Example Press',
        country_code: 'FRA',
        is_active: true,
      });
      await model<PublicationSource>(PublicationSource.name).create({
        publication_name: 'none.example.test',
        feed_url: 'https://none.example.test/rss.xml',
        type: 'rss-feed',
        country_code: 'FRA',
        category: 'general',
        newsPublisherId: publisher._id,
      });
      server.use(
        http.get('https://none.example.test/rss.xml', () =>
          HttpResponse.text(
            feedXml('none.example.test', 'fr', [SHORT_FRENCH]),
            {
              headers: { 'content-type': 'application/rss+xml' },
            },
          ),
        ),
      );
      await h.runJob(QueueName.NEWS_SYNC_FANOUT, {});
      for (const stage of [
        QueueName.LOAD_RSS_FEED,
        QueueName.TRANSLATE_ARTICLE,
        QueueName.GENERATE_EMBEDDING_ARTICLE,
        QueueName.DATABASE_PROJECTOR,
      ]) {
        await h.drain(stage);
      }
      const article = await model<NewsArticle>(NewsArticle.name)
        .findOne({ article_url: 'https://none.example.test/story-0' })
        .lean();
      expect(article?.title_en_internal_only).toBe(SHORT_FRENCH.title);
      expect(takeUnhandled()).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('refuses to boot on an unknown TRANSLATION_PROVIDER, naming the allowed values', async () => {
    process.env.TRANSLATION_PROVIDER = 'gemni';
    await expect(bootAsyncApp().then((h) => h.close())).rejects.toThrow(
      'gemini, routed, none, fake',
    );
  });

  it('refuses to boot on an unknown ARTICLE_ENRICHMENT_PROVIDER', async () => {
    process.env.ARTICLE_ENRICHMENT_PROVIDER = 'gpt';
    await expect(bootAsyncApp().then((h) => h.close())).rejects.toThrow(
      'gemini, openrouter, fake',
    );
  });
});
