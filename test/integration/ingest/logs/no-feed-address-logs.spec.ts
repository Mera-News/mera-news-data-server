import fs from 'fs';
import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { http, HttpResponse } from 'msw';
import type { Model } from 'mongoose';
import { QueueName } from '@mera/shared';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import { bootAsyncApp, type Harness } from '../../../harness/boot';
import { server } from '../../../harness/msw';

const QUERY_MARKER = 'zq7marker41';
const USER_MARKER = 'kd9usermark52';
const PASS_MARKER = 'pw3passmark63';

const BAD_FEED = `https://${USER_MARKER}:${PASS_MARKER}@feeds.example.test/bad?token=${QUERY_MARKER}`;
const SKIP_FEED = `https://${USER_MARKER}:${PASS_MARKER}@feeds.example.test/skip?token=${QUERY_MARKER}`;
const GOOD_FEED = `https://${USER_MARKER}:${PASS_MARKER}@feeds.example.test/good?token=${QUERY_MARKER}`;
const SLOW_FEED = `https://feeds.example.test/slow?token=${QUERY_MARKER}`;
const PLAIN_FEED = 'https://feeds.example.test/plain.xml';

const rss = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Fixture</title><link>https://feeds.example.test/</link><description>Fixture feed</description>
<language>en</language>${items}</channel></rss>`;

const item = (title: string, link: string) => `
<item>
  ${title ? `<title>${title}</title>` : ''}
  <link>${link}</link>
  <description>A fixture story that is long enough to count as a real description for the feed fixture.</description>
  <pubDate>${new Date(Date.now() - 60_000).toUTCString()}</pubDate>
</item>`;

/** Every string the logger, stdout, stderr and direct fd writes receive until `restore()`. */
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
  const fd = jest.spyOn(fs, 'writeSync').mockImplementation(((
    _fd: number,
    data: unknown,
  ) => {
    push(String(data));
    return 0;
  }) as typeof fs.writeSync);
  return {
    lines,
    restore() {
      out.mockRestore();
      err.mockRestore();
      fd.mockRestore();
      Logger.overrideLogger(false);
    },
  };
}

describe('feed address in logs and stored articles', () => {
  let h: Harness;
  let sources: Model<PublicationSource>;

  beforeAll(async () => {
    h = await bootAsyncApp();
    sources = h.app.get<Model<PublicationSource>>(
      getModelToken(PublicationSource.name),
      { strict: false },
    );
  });
  afterAll(() => h?.close());
  beforeEach(() => h.resetDb());

  const addFeed = (feed_url: string, name: string) =>
    sources.create({
      publication_name: name,
      feed_url,
      type: 'rss-feed',
      country_code: 'GBR',
      category: 'general',
    });

  async function load(id: unknown, expectFailure = false) {
    const run = h.runJob(QueueName.LOAD_RSS_FEED, { rssFeedId: String(id) });
    if (expectFailure) await run.catch(() => undefined);
    else await run;
  }

  it('shows origin and path only in every line about a fetch', async () => {
    server.use(
      http.get(
        'https://feeds.example.test/bad',
        () => new HttpResponse(null, { status: 500 }),
      ),
      http.get('https://feeds.example.test/slow', () => HttpResponse.error()),
      http.get('https://feeds.example.test/skip', () =>
        HttpResponse.text(
          rss(
            item('', 'https://feeds.example.test/a') +
              item('Kept story', 'https://feeds.example.test/b'),
          ),
          { headers: { 'content-type': 'application/rss+xml' } },
        ),
      ),
    );
    const bad = await addFeed(BAD_FEED, 'Bad Feed');
    const slow = await addFeed(SLOW_FEED, 'Slow Feed');
    const skip = await addFeed(SKIP_FEED, 'Skip Feed');

    const capture = captureLogs();
    try {
      await load(bad._id, true);
      await load(slow._id, true);
      await load(skip._id);
    } finally {
      capture.restore();
    }

    // Positive control: the lines exist, and name the feed by origin and path.
    const failed = capture.lines.filter((l) =>
      l.includes('Failed to fetch RSS feed Bad Feed'),
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((l) => l.includes('feeds.example.test/bad'))).toBe(
      true,
    );
    const skipped = capture.lines.filter((l) =>
      l.includes('missing a title or link'),
    );
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((l) => l.includes('feeds.example.test/skip'))).toBe(
      true,
    );
    expect(
      capture.lines.some((l) => l.includes('Failed to fetch RSS feed Slow')),
    ).toBe(true);

    for (const marker of [QUERY_MARKER, USER_MARKER, PASS_MARKER]) {
      expect(capture.lines.filter((l) => l.includes(marker))).toEqual([]);
    }
  });

  it('logs a fixed placeholder for a malformed address', async () => {
    const broken = await addFeed(`not a url ${QUERY_MARKER}`, 'Broken Feed');
    const capture = captureLogs();
    try {
      await load(broken._id, true);
    } finally {
      capture.restore();
    }
    const failed = capture.lines.filter((l) =>
      l.includes('Failed to fetch RSS feed Broken Feed'),
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((l) => l.includes('(address withheld)'))).toBe(true);
    expect(capture.lines.filter((l) => l.includes(QUERY_MARKER))).toEqual([]);
  });

  it('fetches the address exactly as given', async () => {
    const seen: string[] = [];
    server.use(
      http.get('https://feeds.example.test/good', ({ request }) => {
        seen.push(request.url);
        return HttpResponse.text(rss(''), {
          headers: { 'content-type': 'application/rss+xml' },
        });
      }),
    );
    const good = await addFeed(GOOD_FEED, 'Good Feed');
    await load(good._id, true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain(`token=${QUERY_MARKER}`);
  });

  it('stores source_uri as origin plus path, and leaves a plain address alone', async () => {
    const xml = rss(item('Stored story', 'https://feeds.example.test/story-1'));
    const plainXml = rss(
      item('Plain story', 'https://feeds.example.test/story-2'),
    );
    server.use(
      http.get('https://feeds.example.test/good', () =>
        HttpResponse.text(xml, {
          headers: { 'content-type': 'application/rss+xml' },
        }),
      ),
      http.get('https://feeds.example.test/plain.xml', () =>
        HttpResponse.text(plainXml, {
          headers: { 'content-type': 'application/rss+xml' },
        }),
      ),
    );
    const good = await addFeed(GOOD_FEED, 'Good Feed');
    const plain = await addFeed(PLAIN_FEED, 'Plain Feed');
    await load(good._id);
    await load(plain._id);

    const articles = h.connection.collection('news-article');
    const stored = await articles.findOne({
      article_url: 'https://feeds.example.test/story-1',
    });
    const storedPlain = await articles.findOne({
      article_url: 'https://feeds.example.test/story-2',
    });
    expect(stored?.source_uri).toBe('https://feeds.example.test/good');
    expect(JSON.stringify(stored)).not.toContain(QUERY_MARKER);
    expect(storedPlain?.source_uri).toBe(PLAIN_FEED);
    // The feed's own record keeps the address it is fetched with.
    const feedAfter = await sources.findById(good._id).lean();
    expect(feedAfter?.feed_url).toBe(GOOD_FEED);
  });
});
