import { getModelToken } from '@nestjs/mongoose';
import { http, HttpResponse } from 'msw';
import type { Model } from 'mongoose';
import { QueueName } from '@mera/shared';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import { bootAsyncApp, type Harness } from '../../../harness/boot';
import { server } from '../../../harness/msw';

describe('feed fetch: server error', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootAsyncApp();
  });
  afterAll(() => h.close());
  beforeEach(() => h.resetDb());

  it('backs the feed off without switching it off', async () => {
    const sources = h.app.get<Model<PublicationSource>>(
      getModelToken(PublicationSource.name),
      {
        strict: false,
      },
    );
    const source = await sources.create({
      publication_name: 'Flaky Courier',
      feed_url: 'https://flaky.example.test/rss.xml',
      type: 'rss-feed',
      country_code: 'GBR',
      category: 'general',
      // Backoff starts at the third consecutive failed cycle.
      consecutive_fetch_failures: 2,
    });
    server.use(
      http.get(
        'https://flaky.example.test/rss.xml',
        () => new HttpResponse(null, { status: 503 }),
      ),
    );

    await expect(
      h.runJob(QueueName.LOAD_RSS_FEED, { rssFeedId: String(source._id) }),
    ).rejects.toThrow();

    const after = await sources.findById(source._id).lean();
    expect(after).toMatchObject({
      is_active: true,
      last_fetch_status: 'http_status',
      last_fetch_http_status: 503,
    });
    expect(after!.fetch_next_attempt_at!.getTime()).toBeGreaterThan(Date.now());
  });
});
