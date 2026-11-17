import { getModelToken } from '@nestjs/mongoose';
import { http, HttpResponse } from 'msw';
import type { Model } from 'mongoose';
import { QueueName } from '@mera/shared';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import { StateMachineFetchPublication } from '@mera/models/models/state-machine-fetch-publication.model';
import { bootAsyncApp, type Harness } from '../../../harness/boot';
import { server } from '../../../harness/msw';

describe('feed fetch: not modified', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootAsyncApp();
  });
  afterAll(() => h.close());
  beforeEach(() => h.resetDb());

  it('records an unchanged fetch as a success and keeps the feed language', async () => {
    const sources = h.app.get<Model<PublicationSource>>(
      getModelToken(PublicationSource.name),
      {
        strict: false,
      },
    );
    const history = h.app.get<Model<StateMachineFetchPublication>>(
      getModelToken(StateMachineFetchPublication.name),
      { strict: false },
    );
    const source = await sources.create({
      publication_name: 'Quiet Gazette',
      feed_url: 'https://quiet.example.test/rss.xml',
      type: 'rss-feed',
      country_code: 'GBR',
      category: 'general',
      feed_language_code: 'de',
      http_etag: '"v1"',
    });
    // Only a conditional request is answered with 304; anything else is a plain failure.
    server.use(
      http.get('https://quiet.example.test/rss.xml', ({ request }) =>
        request.headers.get('if-none-match') === '"v1"'
          ? new HttpResponse(null, { status: 304 })
          : new HttpResponse(null, { status: 500 }),
      ),
    );

    const result = await h.runJob(QueueName.LOAD_RSS_FEED, {
      rssFeedId: String(source._id),
    });

    expect(result).toMatchObject({ result: { success: true, skipped: true } });
    const rows = await history.find({ publicationSourceId: source._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'fetch_unchanged',
      fetch_outcome: 'success',
      fetch_http_status: 304,
    });
    const after = await sources.findById(source._id).lean();
    expect(after).toMatchObject({
      feed_language_code: 'de',
      last_fetch_status: 'ok',
      is_active: true,
    });
  });
});
