import request from 'supertest';
import { QueueName } from '@mera/shared';
import { bootAsyncApp, type Harness } from '../../../harness/boot';

describe('POST /invoke', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await bootAsyncApp();
  });

  afterAll(() => harness?.close());

  const invoke = (body: object, key?: string) => {
    const req = request(harness.app.getHttpServer()).post('/invoke');
    return (key ? req.set('x-api-key', key) : req).send(body);
  };

  it('rejects a wrong key and records nothing', async () => {
    const res = await invoke({ queue_name: 'news-sync-fanout' }, 'wrong-key');
    expect(res.status).toBe(401);
    expect(harness.queues[QueueName.NEWS_SYNC_FANOUT].jobs).toHaveLength(0);
  });

  it('records a job on the fanout queue for the right key', async () => {
    const res = await invoke(
      { queue_name: 'news-sync-fanout', data: { note: 'check' } },
      'harness-api-key',
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true });
    const [job] = harness.queues[QueueName.NEWS_SYNC_FANOUT].take();
    expect(job.name).toBe(res.body.jobName);
    expect(job.data).toEqual({ note: 'check' });
  });

  it('answers 400 for a queue that does not exist here', async () => {
    const res = await invoke({ queue_name: 'send-email' }, 'harness-api-key');
    expect(res.status).toBe(400);
  });
});
