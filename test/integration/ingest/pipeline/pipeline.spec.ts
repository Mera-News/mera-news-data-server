import { getModelToken } from '@nestjs/mongoose';
import { http, HttpResponse } from 'msw';
import type { Model } from 'mongoose';
import { QueueName } from '@mera/shared';
import { NewsArticle } from '@mera/models/models/news-article.model';
import { NewsPublisher } from '@mera/models/models/news-publisher.model';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import { bootAsyncApp, waitFor, type Harness } from '../../../harness/boot';
import { server } from '../../../harness/msw';

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

const ENGLISH: Item[] = [
  { title: 'Harbour council approves new ferry timetable', description: 'The council voted on Tuesday to add two evening crossings to the island ferry.' },
  { title: 'Library opens a seed exchange for gardeners', description: 'Residents can borrow vegetable seeds and return harvested seeds each autumn.' },
];
const GERMAN: Item[] = [
  { title: 'Stadtrat beschliesst neuen Fahrplan fuer die Faehre', description: 'Der Stadtrat hat am Dienstag zwei zusaetzliche Abendfahrten zur Insel beschlossen.' },
  { title: 'Bibliothek eroeffnet eine Saatgutboerse fuer Gaertner', description: 'Anwohner koennen Gemuesesamen ausleihen und im Herbst geerntete Samen zurueckgeben.' },
];

describe('ingest pipeline', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootAsyncApp();
  });
  afterAll(() => h.close());
  beforeEach(() => h.resetDb());

  it('carries every feed item from the fanout to a projected, embedded article', async () => {
    const model = <T>(name: string) => h.app.get<Model<T>>(getModelToken(name), { strict: false });
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
    const expected = feeds.flatMap((f) => f.items.map((_, i) => `https://${f.host}/story-${i}`));
    const stored = await articles.find().select('+embedding_article_data_retrieval').lean();
    expect(stored.map((a) => a.article_url).sort()).toEqual(expected.sort());
    for (const article of stored) {
      expect(article.title_en_internal_only).toBeTruthy();
      expect(article.description_en_internal_only).toBeTruthy();
      expect(article.embedding_article_data_retrieval).toHaveLength(768);
      expect(article.copy_keys?.length).toBeGreaterThan(0);
      // The story key is written after the projector returns, so wait for it.
      await waitFor(() => articles.exists({ _id: article._id, story_key: { $exists: true, $ne: '' } }));
    }
  });
});
