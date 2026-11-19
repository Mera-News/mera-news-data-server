import { ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, Server } from 'node:http';
import { join, resolve } from 'node:path';
import { MongoClient } from 'mongodb';

const repo = resolve(__dirname, '../../..');
const apiKey = process.env.MERA_SERVER_ASYNC_API_KEY ?? 'e2e-local-key';
const appPort = 3102;

const feeds = [
  {
    file: 'alpha.xml',
    publisher: 'Harbor Ledger',
    links: [
      'https://harbor-ledger.example/tram-line',
      'https://harbor-ledger.example/fleet-returns',
    ],
  },
  {
    file: 'beta.xml',
    publisher: 'Valley Courier',
    links: ['https://valley-courier.example/library-hours'],
  },
];
const expectedLinks = feeds.flatMap((f) => f.links);

// Fixture dates are relative to the run, so the load stage's freshness window
// never ages them out: {{HOURS_AGO:n}} becomes an RFC 822 date n hours ago.
const withRunDates = (xml: string) =>
  xml.replace(/\{\{HOURS_AGO:(\d+)\}\}/g, (_m, hours: string) =>
    new Date(Date.now() - Number(hours) * 3_600_000).toUTCString(),
  );

describe('ingest end to end', () => {
  let app: ChildProcess;
  let appLog = '';
  let feedServer: Server;
  let mongo: MongoClient;
  const mongoUri = process.env.MONGODB_URI as string;

  beforeAll(async () => {
    feedServer = createServer((req, res) => {
      const feed = feeds.find((f) => req.url === `/${f.file}`);
      if (!feed) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(withRunDates(readFileSync(join(__dirname, 'fixtures', feed.file), 'utf8')));
    });
    await new Promise<void>((ok) => feedServer.listen(0, '127.0.0.1', ok));
    const feedPort = (feedServer.address() as { port: number }).port;

    mongo = await MongoClient.connect(mongoUri);
    const db = mongo.db();
    for (const feed of feeds) {
      const now = new Date();
      const publisher = await db.collection('news-publisher').insertOne({
        name: feed.publisher,
        country_code: 'USA',
        country_name: 'United States',
        is_active: true,
        createdAt: now,
        updatedAt: now,
      });
      await db.collection('publication-source').insertOne({
        publication_name: feed.publisher,
        feed_url: `http://127.0.0.1:${feedPort}/${feed.file}`,
        type: 'rss-feed',
        feed_language_code: 'en',
        // Alpha-3, as the feed-list import stores it.
        country_code: 'USA',
        country_name: 'United States',
        category: 'general',
        newsPublisherId: publisher.insertedId,
        is_active: true,
        gated: false,
        createdAt: now,
        updatedAt: now,
      });
    }

    app = spawn(
      process.execPath,
      [join(repo, 'dist/apps/mera-server-async/main.js')],
      {
        cwd: repo,
        env: {
          ...process.env,
          PORT: String(appPort),
          NODE_ENV: 'production',
          // The fixture feeds are on loopback, which the fetcher refuses
          // unless the operator lists that exact host and port.
          FEED_FETCH_ALLOW_HOSTS: `127.0.0.1:${feedPort}`,
        },
      },
    );
    app.stdout?.on('data', (d) => (appLog += d));
    app.stderr?.on('data', (d) => (appLog += d));
  });

  afterAll(async () => {
    if (app && app.exitCode === null) {
      app.kill('SIGTERM');
      await new Promise((done) => app.once('exit', done));
    }
    feedServer?.close();
    if (mongo) {
      const db = mongo.db();
      await db.collection('news-article').deleteMany({
        article_url: { $in: expectedLinks },
      });
      await db.collection('publication-source').deleteMany({
        feed_url: { $regex: '^http://127\\.0\\.0\\.1:' },
      });
      await db
        .collection('news-publisher')
        .deleteMany({ name: { $in: feeds.map((f) => f.publisher) } });
      await mongo.close();
    }
  });

  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

  async function invokeFanout(): Promise<void> {
    const deadline = Date.now() + 60_000;
    let last = 'no response';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${appPort}/invoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify({ queue_name: 'news-sync-fanout' }),
        });
        const body = (await res.json()) as { success?: boolean };
        if (res.ok && body.success) return;
        last = `${res.status} ${JSON.stringify(body)}`;
      } catch (e) {
        last = String(e);
      }
      await sleep(1000);
    }
    throw new Error(`/invoke never succeeded: ${last}\n${appLog.slice(-3000)}`);
  }

  it('stores every fixture item with an embedding', async () => {
    await invokeFanout();

    const articles = mongo.db().collection('news-article');
    const deadline = Date.now() + 180_000;
    let missing = expectedLinks;
    while (Date.now() < deadline) {
      const done = await articles
        .find({
          article_url: { $in: expectedLinks },
          embedding_article_data_retrieval: { $exists: true, $ne: [] },
        })
        .project({ article_url: 1 })
        .toArray();
      const doneUrls = new Set(done.map((a) => a.article_url));
      missing = expectedLinks.filter((u) => !doneUrls.has(u));
      if (missing.length === 0) return;
      await sleep(2000);
    }
    throw new Error(
      `Items without a stored article and embedding:\n${missing.join('\n')}\n${appLog.slice(-3000)}`,
    );
  });
});
