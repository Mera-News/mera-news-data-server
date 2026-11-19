import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import { Types, type Connection } from 'mongoose';
import { SeedCanonicalTopicsModule } from '../../../apps/mera-scripts/src/commands/seed-canonical-topics/seed-canonical-topics.module';
import { SeedCanonicalTopicsService } from '../../../apps/mera-scripts/src/commands/seed-canonical-topics/seed-canonical-topics.service';
import { TopicScoresModule } from '../../../apps/mera-scripts/src/commands/topic-scores/topic-scores.module';
import { FakeEmbeddingProvider } from '../../../libs/mera-shared/src/embedding-provider/fake-embedding.provider';
import {
  CANONICAL_TOPIC_LEVELS,
  categoryLevel,
  categoryTreeNodes,
} from '../../../libs/mera-shared/src/enrichment/category-tree';

const L1_PATHS = categoryTreeNodes().filter((p) =>
  CANONICAL_TOPIC_LEVELS.includes(categoryLevel(p)),
).length;

describe('seed-canonical-topics command', () => {
  // Each run embeds the whole category tree with the hashing fake.
  jest.setTimeout(60_000);
  let app: INestApplicationContext;
  let connection: Connection;
  let db: string;
  let lines: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        MongooseModule.forRoot(process.env.MONGODB_URI!),
        SeedCanonicalTopicsModule,
        // Binds the query embedder globally under the same token, as in the app.
        TopicScoresModule,
      ],
    }).compile();
    app = await moduleRef.init();
    connection = app.get<Connection>(getConnectionToken());
    db = connection.db!.databaseName;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    for (const c of await connection.db!.collections()) await c.deleteMany({});
    lines = [];
    const push = (m: unknown) => lines.push(String(m));
    Logger.overrideLogger({
      log: push,
      error: push,
      warn: push,
      debug: push,
      verbose: push,
    });
  });

  afterEach(() => {
    Logger.overrideLogger(false);
  });

  const run = (options: Record<string, unknown>) =>
    app.get(SeedCanonicalTopicsService).run(options);
  const topics = () => connection.collection('user-topic');
  const links = () => connection.collection('topic-article-link');

  it('embeds with the task-aware pipeline embedder, not the global query one', () => {
    expect(app.get(SeedCanonicalTopicsService)['embedder']).toBeInstanceOf(
      FakeEmbeddingProvider,
    );
  });

  it.each([[{ execute: true }], [{ execute: true, allowDb: 'some-other-db' }]])(
    'refuses %p before writing anything',
    async (options) => {
      await expect(run(options)).rejects.toThrow('Refusing to run');
      expect(await topics().countDocuments()).toBe(0);
    },
  );

  it('writes nothing on a dry run', async () => {
    const result = await run({ allowDb: db });

    expect(result).toMatchObject({ rows: L1_PATHS, inserted: 0 });
    expect(await topics().countDocuments()).toBe(0);
  });

  it('seeds every first-level row once, however often it runs', async () => {
    const first = await run({ allowDb: db, execute: true });
    const second = await run({ allowDb: db, execute: true });

    expect(L1_PATHS).toBeGreaterThan(0);
    expect(first.inserted).toBe(L1_PATHS);
    expect(second.inserted).toBe(0);
    expect(await topics().countDocuments({ is_canonical: true })).toBe(
      L1_PATHS,
    );
  });

  it('links a recent article to the row it matches', async () => {
    await run({ allowDb: db, execute: true });
    const row = await topics().findOne({ is_canonical: true });
    const articleId = new Types.ObjectId();
    await connection.collection('news-article').insertOne({
      _id: articleId,
      embedding_article_data_text_matching: row!.canonical_embed as number[],
    });

    const result = await run({ allowDb: db, execute: true });

    expect(result.linksInserted).toBe(1);
    expect(await links().findOne({ articleId })).toMatchObject({
      topicId: row!._id,
      canonical: true,
    });
  });

  describe('with an embedding model the link thresholds were not tuned on', () => {
    const saved = process.env.JINA_MODEL;
    beforeEach(() => {
      process.env.JINA_MODEL = 'some-other-model';
    });
    afterEach(() => {
      process.env.JINA_MODEL = saved;
    });

    it('seeds the rows and writes no links', async () => {
      await run({ allowDb: db, execute: true });
      const row = await topics().findOne({ is_canonical: true });
      await connection.collection('news-article').insertOne({
        embedding_article_data_text_matching: row!.canonical_embed as number[],
      });

      const result = await run({ allowDb: db, execute: true });

      expect(result.rows).toBe(L1_PATHS);
      expect(await links().countDocuments()).toBe(0);
      expect(lines.some((l) => l.includes('backfill skipped'))).toBe(true);
    });
  });
});
