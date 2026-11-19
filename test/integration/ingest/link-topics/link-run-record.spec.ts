import { QueueName } from '@mera/shared';
import { bootAsyncApp, type Harness } from '../../../harness/boot';
import { seedTopic } from '../../retrieval/support/fixtures';

// `status --check linked` waits for the newest run record to say the run
// finished enqueueing, so a run that never marks it stalls that wait forever.
describe('link-all-topics-to-clusters run record', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootAsyncApp();
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.resetDb();
  });

  const newestRun = () =>
    h.connection
      .collection('state-machine-link-topics-to-clusters')
      .findOne({}, { sort: { createdAt: -1 } });

  it('marks the run finished once every topic job is enqueued', async () => {
    const topicId = await seedTopic(h.connection, 'harbour tides');

    await h.runJob(QueueName.LINK_ALL_TOPICS_TO_CLUSTERS, {});

    expect(h.queues[QueueName.LINK_TOPIC_TO_CLUSTERS].take()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ topicId: topicId.toString() }),
      }),
    ]);
    expect(await newestRun()).toMatchObject({
      status: 'enqueue_success',
      totalTopicsEnqueuedForProcessing: 1,
      successfullyEnqueuedCount: 1,
    });
  });

  it('marks a run with no topics finished too', async () => {
    await h.runJob(QueueName.LINK_ALL_TOPICS_TO_CLUSTERS, {});

    expect(await newestRun()).toMatchObject({
      status: 'enqueue_success',
      totalTopicsEnqueuedForProcessing: 0,
    });
  });

  it('marks the run failed when the topic jobs cannot be enqueued', async () => {
    await seedTopic(h.connection, 'harbour tides');
    const queue = h.queues[QueueName.LINK_TOPIC_TO_CLUSTERS];
    const addBulk = jest
      .spyOn(queue, 'addBulk')
      .mockRejectedValueOnce(new Error('redis down'));

    await expect(
      h.runJob(QueueName.LINK_ALL_TOPICS_TO_CLUSTERS, {}),
    ).rejects.toThrow('redis down');
    addBulk.mockRestore();

    expect(await newestRun()).toMatchObject({
      status: 'enqueue_failed',
      errorMessage: 'redis down',
    });
  });
});
