import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { QueueName } from '@mera/shared';
import { NewsArticle } from '@mera/models/models/news-article.model';
import { NewsPublisher } from '@mera/models/models/news-publisher.model';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import { LoadRSSFeedProcessor } from '../../../../apps/mera-server-async/src/modules/sync-news/processor-load-rss-feed/load-rss-feed.processor';
import { NewsSyncFanoutProcessor } from '../../../../apps/mera-server-async/src/modules/sync-news/processor-news-sync-fanout/news-sync-fanout.processor';
import {
  SOURCE_CONNECTOR,
  type SourceConnector,
} from '../../../../apps/mera-server-async/src/modules/shared-utilities/source-connector/source-connector.port';
import { bootAsyncApp, fakeJob } from '../../../harness/boot';

describe('source connector', () => {
  it('fetches every source through the bound connector, not the feed fetcher', async () => {
    const fetched: string[] = [];
    const connector: SourceConnector = {
      fetchSource: (source) => {
        fetched.push(source.feed_url);
        return Promise.resolve({
          items: [0, 1].map((i) => ({
            title: `Connector story number ${i}`,
            description:
              'A story that arrived through the connector rather than over the network, long enough to be detected as English text without translation.',
            link: `https://connector.example.test/story-${i}`,
            pubDate: new Date(Date.now() - (i + 1) * 60_000).toUTCString(),
          })),
          language_code: 'en',
          fetchMeta: {
            via: 'direct' as const,
            httpStatus: 200,
            gated: false,
            bytes: null,
            decodedBytes: 0,
            fetchMs: 0,
          },
        });
      },
    };

    const h = await bootAsyncApp({
      overrides: (builder) =>
        builder.overrideProvider(SOURCE_CONNECTOR).useValue(connector),
    });
    const { app, queues } = h;

    try {
      const model = <T>(name: string) =>
        app.get<Model<T>>(getModelToken(name), { strict: false });
      for (const m of [NewsArticle, PublicationSource, NewsPublisher]) {
        await model(m.name).deleteMany({});
      }
      const publisher = await model<NewsPublisher>(NewsPublisher.name).create({
        name: 'Connector Press',
        country_code: 'GBR',
        is_active: true,
      });
      await model<PublicationSource>(PublicationSource.name).create({
        publication_name: 'Connector Press',
        feed_url: 'https://connector.example.test/rss.xml',
        type: 'rss-feed',
        country_code: 'GBR',
        category: 'general',
        newsPublisherId: publisher._id,
      });

      await app
        .get(NewsSyncFanoutProcessor)
        .process(fakeJob(QueueName.NEWS_SYNC_FANOUT, {}));
      const loadJobs = queues[QueueName.LOAD_RSS_FEED].take();
      expect(loadJobs).toHaveLength(1);
      for (const job of loadJobs) {
        await app
          .get(LoadRSSFeedProcessor)
          .process(fakeJob(QueueName.LOAD_RSS_FEED, job.data, job.opts));
      }

      expect(fetched).toEqual(['https://connector.example.test/rss.xml']);
      const stored = await model<NewsArticle>(NewsArticle.name).find().lean();
      expect(stored.map((a) => a.article_url).sort()).toEqual([
        'https://connector.example.test/story-0',
        'https://connector.example.test/story-1',
      ]);
    } finally {
      // Awaits the story-key chain before closing.
      await h.close();
    }
  });
});
