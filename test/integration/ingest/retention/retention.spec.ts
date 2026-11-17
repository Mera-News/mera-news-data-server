import { Types } from 'mongoose';
import { QueueName, RETENTION_RULES } from '@mera/shared';
import { bootAsyncApp, type Harness } from '../../../harness/boot';

const DAY = 24 * 3600_000;

describe('data retention sweep', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await bootAsyncApp();
  });

  afterAll(() => harness?.close());

  beforeEach(() => harness.resetDb());

  it('every rule and cascade names a model registered on the connection', () => {
    const registered = Object.keys(harness.connection.models);
    const named = RETENTION_RULES.flatMap((r) => [
      r.model,
      ...(r.cascade ?? []).map((c) => c.model),
    ]);
    expect(named.filter((m) => !registered.includes(m))).toEqual([]);
  });

  it('removes an old article with its links and keeps a fresh one', async () => {
    const { connection } = harness;
    const insert = async (model: string, doc: object) =>
      (await connection.model(model).collection.insertOne(doc)).insertedId;
    const oldAt = new Date(Date.now() - 10 * DAY);
    const freshAt = new Date(Date.now() - 1000);

    const oldId = await insert('NewsArticle', {
      title: 'old',
      article_url: 'https://news.example.test/old',
      createdAt: oldAt,
    });
    const freshId = await insert('NewsArticle', {
      title: 'fresh',
      article_url: 'https://news.example.test/fresh',
      createdAt: freshAt,
    });
    for (const articleId of [oldId, freshId]) {
      await insert('ClusterArticleLink', {
        articleId,
        clusterId: new Types.ObjectId(),
      });
      await insert('TopicArticleLink', {
        articleId,
        topicId: new Types.ObjectId(),
      });
    }

    await harness.runJob(QueueName.DATA_RETENTION_SWEEP, {
      onlyModels: ['NewsArticle'],
      skipOrphans: true,
    });

    const count = (model: string, articleId: Types.ObjectId) =>
      connection.model(model).countDocuments({ articleId });
    expect(
      await connection.model('NewsArticle').countDocuments({ _id: oldId }),
    ).toBe(0);
    expect(await count('ClusterArticleLink', oldId)).toBe(0);
    expect(await count('TopicArticleLink', oldId)).toBe(0);
    expect(
      await connection.model('NewsArticle').countDocuments({ _id: freshId }),
    ).toBe(1);
    expect(await count('ClusterArticleLink', freshId)).toBe(1);
    expect(await count('TopicArticleLink', freshId)).toBe(1);
  });
});
