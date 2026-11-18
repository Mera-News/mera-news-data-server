import { Types } from 'mongoose';
import { RETENTION_RULES, type RetentionRule } from '@mera/shared';
import { DataRetentionSweepService } from '../../../../apps/mera-server-async/src/modules/data-retention/processor-data-retention-sweep/data-retention-sweep.service';
import { bootAsyncApp, type Harness } from '../../../harness/boot';

const DAY = 24 * 3600_000;

describe('data retention sweep with a failing rule', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await bootAsyncApp();
  });

  afterAll(() => harness?.close());

  beforeEach(() => harness.resetDb());

  const badRule: RetentionRule = {
    model: 'NoSuchModel',
    ageField: 'createdAt',
    maxAgeMs: 1,
  };
  const realRule = RETENTION_RULES.find(
    (r) => r.model === 'ArticleFingerprint',
  ) as RetentionRule;

  const seed = async () => {
    const collection =
      harness.connection.model('ArticleFingerprint').collection;
    const oldId = (
      await collection.insertOne({
        article_url: 'https://news.example.test/old',
        createdAt: new Date(Date.now() - realRule.maxAgeMs - DAY),
      })
    ).insertedId;
    const freshId = (
      await collection.insertOne({
        article_url: 'https://news.example.test/fresh',
        createdAt: new Date(Date.now() - 1000),
      })
    ).insertedId;
    const exists = async (_id: unknown) =>
      (await collection.countDocuments({ _id } as object)) === 1;
    return { oldId, freshId, exists };
  };

  it('sweeps the later rules, then fails naming the broken one', async () => {
    const { oldId, freshId, exists } = await seed();
    const service = new DataRetentionSweepService(harness.connection, [
      badRule,
      realRule,
    ]);

    await expect(
      service.sweep({ skipOrphans: true }, new AbortController().signal),
    ).rejects.toThrow(/NoSuchModel/);

    expect(await exists(oldId)).toBe(false);
    expect(await exists(freshId)).toBe(true);
  });

  it('runs the orphan pass after a failed rule, then fails naming it', async () => {
    const links = harness.connection.model('TopicArticleLink').collection;
    // A link whose topic no longer exists: the orphan pass removes it.
    const orphanId = (
      await links.insertOne({
        topicId: new Types.ObjectId(),
        articleId: new Types.ObjectId(),
        createdAt: new Date(),
      })
    ).insertedId;
    const service = new DataRetentionSweepService(harness.connection, [
      badRule,
    ]);

    await expect(
      service.sweep({}, new AbortController().signal),
    ).rejects.toThrow('Retention rules failed: NoSuchModel');

    expect(await links.countDocuments({ _id: orphanId })).toBe(0);
  });

  it('still stops at once when the signal is aborted', async () => {
    const { oldId, exists } = await seed();
    const service = new DataRetentionSweepService(harness.connection, [
      realRule,
    ]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      service.sweep({ skipOrphans: true }, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await exists(oldId)).toBe(true);
  });
});
