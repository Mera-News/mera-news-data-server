import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { QueueName } from '@mera/shared';
import { installAtlasSearchFake } from '../../../harness/atlas-search-fake';
import { bootAsyncApp, type Harness } from '../../../harness/boot';
import {
  seedArticle,
  seedSource,
  seedTopic,
  vectorWithScore,
} from '../../retrieval/support/fixtures';

/** Every string the logger, stdout and stderr receive until `restore()`. */
function captureLogs() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(
      args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' '),
    );
  };
  Logger.overrideLogger({
    log: push,
    error: push,
    warn: push,
    debug: push,
    verbose: push,
    fatal: push,
  });
  const out = jest.spyOn(process.stdout, 'write').mockImplementation((c) => {
    push(String(c));
    return true;
  });
  const err = jest.spyOn(process.stderr, 'write').mockImplementation((c) => {
    push(String(c));
    return true;
  });
  return {
    lines,
    restore() {
      out.mockRestore();
      err.mockRestore();
      Logger.overrideLogger(false);
    },
  };
}

describe('topic linking logs', () => {
  let harness: Harness;
  let fake: ReturnType<typeof installAtlasSearchFake>;

  beforeAll(async () => {
    fake = installAtlasSearchFake();
    harness = await bootAsyncApp();
  });
  afterAll(async () => {
    await harness?.close();
    fake.uninstall();
  });

  it('logs the topic id and counts, never the topic text', async () => {
    const text = 'Quokka migration log topic';
    await harness.resetDb();
    const source = await seedSource(harness.connection);
    for (const score of [1.0, 0.95]) {
      await seedArticle(harness.connection, {
        source,
        vector: vectorWithScore(text, score),
      });
    }
    const topicId = await seedTopic(harness.connection, text);

    const capture = captureLogs();
    try {
      await harness.runJob(QueueName.LINK_TOPIC_TO_CLUSTERS, {
        topicId: topicId.toString(),
        userTopicLinkingResultId: new Types.ObjectId().toString(),
      });
    } finally {
      capture.restore();
    }

    expect(
      capture.lines.some((l) =>
        l.includes(`Topic ${topicId.toString()}: linked`),
      ),
    ).toBe(true);
    expect(capture.lines.filter((l) => l.includes(text))).toEqual([]);
  });
});
