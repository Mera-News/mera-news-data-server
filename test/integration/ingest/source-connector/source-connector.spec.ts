import { ValidationPipe } from '@nestjs/common';
import { BullRegistrar, getQueueToken } from '@nestjs/bullmq';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { createCache } from 'cache-manager';
import type { Model } from 'mongoose';
import { ArticleCacheService, QueueName } from '@mera/shared';
import { NewsArticle } from '@mera/models/models/news-article.model';
import { NewsPublisher } from '@mera/models/models/news-publisher.model';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import { MeraServerAsyncModule } from '../../../../apps/mera-server-async/src/async.module';
import { LoadRSSFeedProcessor } from '../../../../apps/mera-server-async/src/modules/sync-news/processor-load-rss-feed/load-rss-feed.processor';
import { NewsSyncFanoutProcessor } from '../../../../apps/mera-server-async/src/modules/sync-news/processor-news-sync-fanout/news-sync-fanout.processor';
import {
  SOURCE_CONNECTOR,
  type SourceConnector,
} from '../../../../apps/mera-server-async/src/modules/shared-utilities/source-connector/source-connector.port';
import {
  QueueRecorder,
  fakeJob,
  memoryRedisClient,
} from '../../../harness/boot';

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

    const queues = Object.fromEntries(
      Object.values(QueueName).map((n) => [n, new QueueRecorder(n)]),
    ) as Record<QueueName, QueueRecorder>;
    let builder = Test.createTestingModule({ imports: [MeraServerAsyncModule] })
      .overrideProvider(BullRegistrar)
      .useValue({ onModuleInit: () => undefined })
      .overrideProvider(CACHE_MANAGER)
      .useValue(createCache())
      .overrideProvider(ArticleCacheService)
      .useValue(new ArticleCacheService({ ttlMs: 60_000 }, memoryRedisClient()))
      .overrideProvider(SOURCE_CONNECTOR)
      .useValue(connector);
    for (const n of Object.values(QueueName)) {
      builder = builder.overrideProvider(getQueueToken(n)).useValue(queues[n]);
    }
    const app = (await builder.compile()).createNestApplication({
      logger: false,
    });
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true }),
    );
    await app.init();

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
      await app.close();
    }
  });
});
