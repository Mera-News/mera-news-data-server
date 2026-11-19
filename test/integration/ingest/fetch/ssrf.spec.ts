import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { getModelToken } from '@nestjs/mongoose';
import { UnrecoverableError } from 'bullmq';
import { http, HttpResponse } from 'msw';
import { Types, type Model } from 'mongoose';
import { QueueName } from '@mera/shared';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import { UrlSecurityState } from '@mera/shared/url/url-security';
import { findEgressRefusal } from '../../../../libs/mera-shared/src/url/public-egress';
import { AxiosService } from '../../../../apps/mera-server-async/src/modules/shared-utilities/axios/axios.service';
import { RSSFeedService } from '../../../../apps/mera-server-async/src/modules/shared-utilities/rss-feed/rss-feed.service';
import { UrlSecurityProbeService } from '../../../../apps/mera-server-async/src/modules/shared-utilities/url-security/url-security-probe.service';
import { bootAsyncApp, type Harness } from '../../../harness/boot';
import { server } from '../../../harness/msw';

// Every refusal below has a handler that would answer 200 with a valid feed,
// so a request that slips through shows up as a hit and as a loaded feed.

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Fixture</title><link>https://feeds.example.test/</link><description>Fixture feed</description>
<language>en</language>
<item>
  <title>A fixture story</title>
  <link>https://feeds.example.test/story</link>
  <description>A fixture story that is long enough to count as a real description for the feed fixture.</description>
  <pubDate>${new Date(Date.now() - 60_000).toUTCString()}</pubDate>
</item></channel></rss>`;

const answerFeed = (hits: string[]) => (info: { request: Request }) => {
  hits.push(info.request.url);
  return HttpResponse.text(FEED, {
    headers: { 'content-type': 'application/rss+xml' },
  });
};

describe('feed fetch: private addresses', () => {
  let h: Harness;
  let sources: Model<PublicationSource>;
  const saved: Record<string, string | undefined> = {};
  const env = {
    // Exact host and port: an IPv4 literal on 8080 and a local name on 8080.
    FEED_FETCH_ALLOW_HOSTS: '10.0.0.5:8080,intranet.localhost:8080',
    PROXY_URLS: 'http://proxy.example.test:3128',
    PROXY_FETCH_RETRIES: '2',
    HTTP_UPGRADE_PROBE_ENABLED: 'true',
  };

  beforeAll(async () => {
    for (const [key, value] of Object.entries(env)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    h = await bootAsyncApp();
    sources = h.app.get<Model<PublicationSource>>(
      getModelToken(PublicationSource.name),
      { strict: false },
    );
  });
  afterAll(async () => {
    await h?.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  beforeEach(() => h.resetDb());

  const addFeed = (feed_url: string, gated = false) =>
    sources.create({
      publication_name: 'Fixture Courier',
      feed_url,
      type: 'rss-feed',
      country_code: 'GBR',
      category: 'general',
      gated,
    });
  const load = (id: unknown, cycleId = 'cycle-1') =>
    h.runJob(QueueName.LOAD_RSS_FEED, { rssFeedId: String(id), cycleId });

  describe.each([
    ['through the pool', false],
    ['direct (gated)', true],
  ])('a private literal address %s', (_label, gated) => {
    it('is refused with no request and no retry', async () => {
      const hits: string[] = [];
      server.use(
        http.get('http://169.254.169.254/latest/meta-data/', answerFeed(hits)),
      );
      const feed = await addFeed(
        'http://169.254.169.254/latest/meta-data/',
        gated,
      );

      const failure = await load(feed._id).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(UnrecoverableError);
      expect(hits).toEqual([]);
      const after = await sources.findById(feed._id).lean();
      expect(after).toMatchObject({
        last_fetch_status: 'refused',
        consecutive_fetch_failures: 1,
      });
      expect(after!.last_fetch_error).toBe(
        'refused: 169.254.169.254 is not a public address; add it to FEED_FETCH_ALLOW_HOSTS',
      );
    });
  });

  it('refuses a data: address instead of decoding it in memory', async () => {
    const feed = await addFeed(
      `data:application/rss+xml,${encodeURIComponent(FEED)}`,
    );

    await expect(load(feed._id)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(await sources.findById(feed._id).lean()).toMatchObject({
      last_fetch_status: 'refused',
    });
  });

  it('refuses a redirect into a private address, after the first request only', async () => {
    const first: string[] = [];
    const second: string[] = [];
    // http, so the pool's own instance (which has no proxy for http) answers
    // and a retry or the direct fallback would show as more requests.
    server.use(
      http.get('http://feeds.example.test/hop', ({ request }) => {
        first.push(request.url);
        return new HttpResponse(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/secret.xml' },
        });
      }),
      http.get('http://127.0.0.1/secret.xml', answerFeed(second)),
    );
    const feed = await addFeed('http://feeds.example.test/hop');

    await expect(load(feed._id)).rejects.toBeInstanceOf(UnrecoverableError);

    // One request: a refusal is no reason to try another proxy or go direct.
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(await sources.findById(feed._id).lean()).toMatchObject({
      last_fetch_status: 'refused',
    });
  });

  // Through the pool the agents never see a hop's address (the proxy connects
  // for us), so the redirect check is the only guard there. Under MSW every
  // socket is built by the strict agents, which would refuse first, so the
  // check is called directly.
  it('refuses a private hop in the redirect check itself, whatever the agents allow', () => {
    type Guarded = {
      beforeRedirect: (
        options: { protocol: string; hostname: string; port?: string },
        details: { statusCode: number },
      ) => void;
    };
    const service = h.app.get(AxiosService) as unknown as {
      guarded(config: object, listed: boolean): Guarded;
    };
    const hop = (listed: boolean, hostname: string, port = '') =>
      service
        .guarded({ url: 'https://feeds.example.test/feed' }, listed)
        .beforeRedirect(
          { protocol: 'https:', hostname, port },
          { statusCode: 302 },
        );

    expect(() => hop(false, '10.0.0.1')).toThrow(
      'refused: 10.0.0.1 is not a public address',
    );
    expect(() => hop(false, 'intranet.localhost', '8080')).toThrow(
      'is a local name',
    );
    expect(() => hop(false, 'feeds.example.test')).not.toThrow();
    // A listed hop passes only for a listed source, and only on its port.
    expect(() => hop(true, '10.0.0.5', '8080')).not.toThrow();
    expect(() => hop(false, '10.0.0.5', '8080')).toThrow('is not a public');
    expect(() => hop(true, '10.0.0.5', '9090')).toThrow('is not a public');
  });

  // A real loopback server, not MSW: a mocked socket never resets the idle
  // timer, so only real bytes on a real socket show that the attempt's own
  // deadline is what ends a dripping body.
  it('gives up on a body that keeps dripping, at twice the per-attempt timeout', async () => {
    const drip = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      const tick = setInterval(() => res.write(' '), 50);
      res.on('close', () => clearInterval(tick));
    });
    await new Promise<void>((resolve) => drip.listen(0, '127.0.0.1', resolve));
    const { port } = drip.address() as AddressInfo;
    const saved = {
      PROXY_FETCH_TIMEOUT_MS: process.env.PROXY_FETCH_TIMEOUT_MS,
      FEED_FETCH_ALLOW_HOSTS: process.env.FEED_FETCH_ALLOW_HOSTS,
    };
    process.env.PROXY_FETCH_TIMEOUT_MS = '200';
    process.env.FEED_FETCH_ALLOW_HOSTS = `127.0.0.1:${port}`;
    let service: AxiosService;
    try {
      // A fresh ConfigService: the app's caches what it read at boot.
      service = new AxiosService(new ConfigService());
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const started = Date.now();
    try {
      await expect(
        new RSSFeedService(service).fetchRSSFeed({
          _id: new Types.ObjectId(),
          feed_url: `http://127.0.0.1:${port}/drip`,
          gated: true,
        } as unknown as PublicationSource),
      ).rejects.toMatchObject({ name: 'FeedFetchError', category: 'timeout' });
    } finally {
      drip.closeAllConnections();
      drip.close();
    }
    // Past the 200 ms idle timer (bytes keep arriving), at the 400 ms deadline.
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(350);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('runs the caller redirect hook before refusing a hop', async () => {
    server.use(
      http.get(
        'https://feeds.example.test/hop-hook',
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: 'http://127.0.0.1/secret.xml' },
          }),
      ),
    );
    const statuses: number[] = [];

    const failure = await h.app
      .get(AxiosService)
      .callWithoutProxy({
        url: 'https://feeds.example.test/hop-hook',
        beforeRedirect: (
          _options: unknown,
          details: { statusCode?: number },
        ) => {
          statuses.push(details.statusCode!);
        },
      })
      .catch((e: unknown) => e);

    expect(statuses).toEqual([302]);
    // follow-redirects wraps what a hook throws.
    expect(findEgressRefusal(failure)).toMatchObject({
      code: 'EGRESS_REFUSED',
    });
  });

  it('deactivates a refused feed after three cycles and never queues a retry', async () => {
    const hits: string[] = [];
    server.use(http.get('http://192.168.1.10/feed.xml', answerFeed(hits)));
    const feed = await addFeed('http://192.168.1.10/feed.xml');

    for (const cycle of ['c1', 'c2', 'c3']) {
      const failure = await load(feed._id, cycle).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(UnrecoverableError);
    }

    expect(hits).toEqual([]);
    expect(await sources.findById(feed._id).lean()).toMatchObject({
      is_active: false,
      deactivation_reason: 'auto_fetch_failures',
    });
    expect(h.queues[QueueName.LOAD_RSS_FEED].jobs).toEqual([]);
  });

  describe('the allowlist', () => {
    it('fetches a listed host and port direct, even with a proxy pool set', async () => {
      const hits: string[] = [];
      server.use(http.get('http://10.0.0.5:8080/rss.xml', answerFeed(hits)));
      const feed = await addFeed('http://10.0.0.5:8080/rss.xml');

      await load(feed._id);

      expect(hits).toHaveLength(1);
      expect(await sources.findById(feed._id).lean()).toMatchObject({
        last_fetch_status: 'ok',
        last_fetch_via: 'direct',
      });
    });

    it('refuses the same host on a port that is not listed', async () => {
      const hits: string[] = [];
      server.use(http.get('http://10.0.0.5:9090/rss.xml', answerFeed(hits)));
      const feed = await addFeed('http://10.0.0.5:9090/rss.xml');

      await expect(load(feed._id)).rejects.toBeInstanceOf(UnrecoverableError);

      expect(hits).toEqual([]);
    });

    it('refuses another local name on a listed port', async () => {
      const hits: string[] = [];
      server.use(
        http.get('http://other.localhost:8080/rss.xml', answerFeed(hits)),
      );
      const feed = await addFeed('http://other.localhost:8080/rss.xml');

      await expect(load(feed._id)).rejects.toBeInstanceOf(UnrecoverableError);

      expect(hits).toEqual([]);
    });

    it('refuses an unlisted source that redirects to a listed private host', async () => {
      const hits: string[] = [];
      server.use(
        http.get(
          'https://feeds.example.test/to-lan',
          () =>
            new HttpResponse(null, {
              status: 302,
              headers: { location: 'http://10.0.0.5:8080/rss.xml' },
            }),
        ),
        http.get('http://10.0.0.5:8080/rss.xml', answerFeed(hits)),
      );
      const feed = await addFeed('https://feeds.example.test/to-lan');

      await expect(load(feed._id)).rejects.toBeInstanceOf(UnrecoverableError);

      expect(hits).toEqual([]);
    });

    it('never lifts the scheme rule for a listed host', async () => {
      const feed = await addFeed('ftp://10.0.0.5:8080/rss.xml');

      await expect(load(feed._id)).rejects.toBeInstanceOf(UnrecoverableError);

      expect((await sources.findById(feed._id).lean())!.last_fetch_error).toBe(
        'refused: 10.0.0.5 uses a scheme other than http or https',
      );
    });
  });

  it('identifies the fetcher with the self-hosted User-Agent by default', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get('https://feeds.example.test/agent.xml', ({ request }) => {
        seen.push(request.headers.get('user-agent'));
        return HttpResponse.text(FEED, {
          headers: { 'content-type': 'application/rss+xml' },
        });
      }),
    );
    const feed = await addFeed('https://feeds.example.test/agent.xml');

    await load(feed._id);

    expect(seen).toEqual(['mera-news-data-server (self-hosted)']);
  });

  describe('the https upgrade probe', () => {
    const resolve = (articleUrl: string) =>
      h.app.get(UrlSecurityProbeService).resolveBatch([{ articleUrl }]);

    it('treats a private literal target as https unavailable, with no request', async () => {
      const hits: string[] = [];
      server.use(
        http.all('https://169.254.169.254/story', ({ request }) => {
          hits.push(request.method);
          return new HttpResponse(null, { status: 200 });
        }),
      );

      const [result] = await resolve('http://169.254.169.254/story');

      expect(result.state).toBe(UrlSecurityState.INSECURE);
      expect(result.articleUrl).toBe('http://169.254.169.254/story');
      expect(hits).toEqual([]);
    });

    it('upgrades a host whose https answers', async () => {
      server.use(
        http.all(
          'https://probe-ok.example.test/story',
          () => new HttpResponse(null, { status: 200 }),
        ),
      );

      const [result] = await resolve('http://probe-ok.example.test/story');

      expect(result).toMatchObject({
        state: UrlSecurityState.UPGRADED,
        articleUrl: 'https://probe-ok.example.test/story',
      });
    });

    it('does not count a bounce back to http as an upgrade', async () => {
      server.use(
        http.all(
          'https://probe-bounce.example.test/story',
          () =>
            new HttpResponse(null, {
              status: 301,
              headers: { location: 'http://probe-bounce.example.test/story' },
            }),
        ),
        http.all(
          'http://probe-bounce.example.test/story',
          () => new HttpResponse(null, { status: 200 }),
        ),
      );

      const [result] = await resolve('http://probe-bounce.example.test/story');

      expect(result.state).toBe(UrlSecurityState.INSECURE);
    });
  });
});
