import { INestApplication, Type, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BullRegistrar, getQueueToken } from '@nestjs/bullmq';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { getConnectionToken } from '@nestjs/mongoose';
import { createCache } from 'cache-manager';
import type { Job, JobsOptions } from 'bullmq';
import type { Connection } from 'mongoose';
import {
  ArticleCacheService,
  HttpExceptionFilter,
  QueueName,
  type ArticleCacheRedisClient,
} from '@mera/shared';
import { MeraServerAsyncModule } from '../../apps/mera-server-async/src/async.module';
import { NewsSyncFanoutProcessor } from '../../apps/mera-server-async/src/modules/sync-news/processor-news-sync-fanout/news-sync-fanout.processor';
import { LoadRSSFeedProcessor } from '../../apps/mera-server-async/src/modules/sync-news/processor-load-rss-feed/load-rss-feed.processor';
import { TranslateArticleProcessor } from '../../apps/mera-server-async/src/modules/sync-news/processor-translate-article/translate-article.processor';
import { GenerateEmbeddingProcessor } from '../../apps/mera-server-async/src/modules/sync-news/processor-generate-embedding-news-article/generate-embedding.processor';
import { DatabaseProjectorProcessor } from '../../apps/mera-server-async/src/modules/sync-news/processor-database-projector/database-projector.processor';
import { PreProcessArticlesFanoutProcessor } from '../../apps/mera-server-async/src/modules/sync-news/processor-pre-process-articles-fanout/pre-process-articles-fanout.processor';
import { PreProcessArticlesProcessor } from '../../apps/mera-server-async/src/modules/sync-news/processor-pre-process-articles/pre-process-articles.processor';
import { LinkAllTopicsToClustersProcessor } from '../../apps/mera-server-async/src/modules/link-topics-to-clusters/processor-link-all-topics-to-clusters/link-all-topics-to-clusters.processor';
import { LinkTopicToClusterProcessor } from '../../apps/mera-server-async/src/modules/link-topics-to-clusters/processor-link-topic-to-clusters/link-topic-to-clusters.processor';
import { BuildHeadlineEditionsProcessor } from '../../apps/mera-server-async/src/modules/headline-editions/processor-build-headline-editions/build-headline-editions.processor';
import { StoryKeyIndexService } from '../../apps/mera-server-async/src/modules/sync-news/processor-database-projector/story-key-index.service';
import { DataRetentionSweepProcessor } from '../../apps/mera-server-async/src/modules/data-retention/processor-data-retention-sweep/data-retention-sweep.processor';

/** The processor that consumes each queue. */
export const PROCESSORS: Partial<Record<QueueName, Type<{ process(job: Job): Promise<unknown> }>>> = {
  [QueueName.NEWS_SYNC_FANOUT]: NewsSyncFanoutProcessor,
  [QueueName.LOAD_RSS_FEED]: LoadRSSFeedProcessor,
  [QueueName.TRANSLATE_ARTICLE]: TranslateArticleProcessor,
  [QueueName.GENERATE_EMBEDDING_ARTICLE]: GenerateEmbeddingProcessor,
  [QueueName.DATABASE_PROJECTOR]: DatabaseProjectorProcessor,
  [QueueName.PRE_PROCESS_ARTICLES_FANOUT]: PreProcessArticlesFanoutProcessor,
  [QueueName.PRE_PROCESS_ARTICLES]: PreProcessArticlesProcessor,
  [QueueName.LINK_ALL_TOPICS_TO_CLUSTERS]: LinkAllTopicsToClustersProcessor,
  [QueueName.LINK_TOPIC_TO_CLUSTERS]: LinkTopicToClusterProcessor,
  [QueueName.BUILD_HEADLINE_EDITIONS]: BuildHeadlineEditionsProcessor,
  [QueueName.DATA_RETENTION_SWEEP]: DataRetentionSweepProcessor,
};

export interface RecordedJob {
  name: string;
  data: unknown;
  opts?: JobsOptions;
}

/** Stands in for a BullMQ Queue: records what the code enqueues. */
export class QueueRecorder {
  readonly jobs: RecordedJob[] = [];
  private nextId = 1;

  constructor(readonly name: string) {}

  add(name: string, data: unknown, opts?: JobsOptions) {
    this.jobs.push({ name, data, opts });
    return Promise.resolve({ id: String(this.nextId++), name, data });
  }

  addBulk(jobs: RecordedJob[]) {
    return Promise.all(jobs.map((j) => this.add(j.name, j.data, j.opts)));
  }

  /** Removes and returns every recorded job. */
  take(): RecordedJob[] {
    return this.jobs.splice(0);
  }
}

/** A Map-backed stand-in for the node-redis client the article cache uses. */
export function memoryRedisClient(): ArticleCacheRedisClient {
  const store = new Map<string, string>();
  return {
    isOpen: true,
    connect: () => Promise.resolve(),
    quit: () => Promise.resolve(),
    mGet: (keys) => Promise.resolve(keys.map((k) => store.get(k) ?? null)),
    set: (key, value) => Promise.resolve(store.set(key, value)),
    del: (keys) => Promise.resolve(keys.forEach((k) => store.delete(k))),
    on: () => undefined,
  };
}

/** The job fields MeraWorkerHost and the processors read. */
export function fakeJob<T>(queueName: string, data: T, opts: JobsOptions = {}): Job<T> {
  const job = {
    id: `${queueName}-${Date.now()}`,
    name: queueName,
    queueName,
    data,
    opts: { attempts: 1, ...opts },
    attemptsMade: 0,
    timestamp: Date.now(),
    log: () => Promise.resolve(0),
    updateProgress: () => Promise.resolve(),
    updateData: (next: T) => {
      job.data = next;
      return Promise.resolve();
    },
  };
  return job as unknown as Job<T>;
}

export interface Harness {
  app: INestApplication;
  queues: Record<QueueName, QueueRecorder>;
  connection: Connection;
  /** Runs one job through the queue's real processor. */
  runJob(queue: QueueName, data: unknown, opts?: JobsOptions): Promise<unknown>;
  /** Runs every recorded job of `queue` (and any it re-enqueues) until none is left. */
  drain(queue: QueueName): Promise<number>;
  /** Deletes every document in every collection of this worker's database. */
  resetDb(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Boots the real async app on the harness: the in-memory Mongo replica set
 * from global-setup, a recorder per queue, no BullMQ worker, and memory
 * stand-ins for both Redis caches. Mirrors main.ts's pipe and filter.
 */
export async function bootAsyncApp({
  module = MeraServerAsyncModule,
  processors = {},
}: {
  /** The root Nest module to boot. */
  module?: Type<unknown>;
  /** Processors merged over the built-in map when `runJob` looks up a queue. */
  processors?: typeof PROCESSORS;
} = {}): Promise<Harness> {
  const queues = Object.fromEntries(
    Object.values(QueueName).map((name) => [name, new QueueRecorder(name)]),
  ) as Record<QueueName, QueueRecorder>;

  let builder = Test.createTestingModule({ imports: [module] })
    // No worker may open a Redis connection.
    .overrideProvider(BullRegistrar)
    .useValue({ onModuleInit: () => undefined })
    .overrideProvider(CACHE_MANAGER)
    .useValue(createCache())
    .overrideProvider(ArticleCacheService)
    .useValue(new ArticleCacheService({ ttlMs: 60_000 }, memoryRedisClient()));
  for (const name of Object.values(QueueName)) {
    builder = builder.overrideProvider(getQueueToken(name)).useValue(queues[name]);
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new HttpExceptionFilter(true));
  app.enableShutdownHooks();
  await app.init();

  const connection = app.get<Connection>(getConnectionToken());

  const runJob = (queue: QueueName, data: unknown, opts?: JobsOptions) => {
    const processor = { ...PROCESSORS, ...processors }[queue];
    if (!processor) throw new Error(`No processor registered for queue ${queue}`);
    return app.get(processor, { strict: false }).process(fakeJob(queue, data, opts));
  };

  const drain = async (queue: QueueName) => {
    let ran = 0;
    for (let batch = queues[queue].take(); batch.length; batch = queues[queue].take()) {
      for (const job of batch) {
        await runJob(queue, job.data, job.opts);
        ran++;
      }
    }
    return ran;
  };

  const resetDb = async () => {
    const collections = await connection.db!.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  };

  // The story-key index rebuilds unawaited at boot on a private promise chain.
  // Closing mid-rebuild ends its Mongo session and logs a failure, so wait.
  const close = async () => {
    const index = app.get(StoryKeyIndexService, { strict: false });
    await (index as unknown as { chain: Promise<unknown> }).chain;
    await app.close();
  };

  return { app, queues, connection, runJob, drain, resetDb, close };
}

/** Polls `check` until it returns a truthy value (for writes the code does not await). */
export async function waitFor<T>(check: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
