import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createFakeEmbedder } from '../src/embed/fake.ts';
import { FetchError, fetchFeed } from '../src/ingest/fetch.ts';
import { CONTACT_KEY, runIngest, userAgentFor, type IngestEvent } from '../src/ingest/ingest.ts';
import { createLanguageDetector, type LanguageDetector } from '../src/ingest/language.ts';
import { acquireWriteLock } from '../src/ingest/lock.ts';
import { parseFeed } from '../src/ingest/parse.ts';
import { parseAllowHosts } from '../src/ingest/shared.ts';
import { Store, StoreError } from '../src/store/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'mera-news-local-ingest-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const freshPath = () => join(dir, `news-${++n}.db`);

const rss = (title: string, items: { title: string; link: string; description?: string; pubDate?: string }[], language?: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${title}</title>${language ? `<language>${language}</language>` : ''}${items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link>${i.description ? `<description>${i.description}</description>` : ''}${i.pubDate ? `<pubDate>${i.pubDate}</pubDate>` : ''}</item>`)
    .join('')}</channel></rss>`;

const now = () => new Date().toUTCString();
const HARBOUR = rss('Harbour Gazette', [
  { title: 'Brightwater orders forty electric buses for its city routes', link: 'https://harbour.example.test/buses', description: 'The council signed the contract on Tuesday after a long debate about charging depots.', pubDate: now() },
  { title: 'Lighthouse reopens to visitors after three years of work', link: 'https://harbour.example.test/lighthouse?utm_source=rss', description: 'Volunteers restored the lamp room and the stairs of the old tower.', pubDate: now() },
  { title: 'An archive item from long ago', link: 'https://harbour.example.test/archive', description: 'Kept, because nothing expires in the one-computer setup.', pubDate: 'Fri, 01 Mar 2019 10:00:00 GMT' },
]);
const TOKYO = rss(
  '東京ニュース',
  [{ title: '東京で新しい電気バスが走り始めた', link: 'https://tokyo.example.test/bus', description: '都内の路線で、電気で走る新しいバスの運行が始まりました。乗客からは静かだという声が聞かれます。', pubDate: now() }],
  'ja',
);

interface Hit {
  path: string;
  at: number;
  headers: IncomingMessage['headers'];
}

let server: Server;
let base = '';
let hits: Hit[] = [];
let inFlight = new Map<string, number>();
let maxInFlightPerHost = 0;
const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>>();

before(async () => {
  server = createServer(async (req, res) => {
    const path = req.url ?? '/';
    hits.push({ path, at: Date.now(), headers: req.headers });
    const host = req.headers.host ?? '';
    inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
    maxInFlightPerHost = Math.max(maxInFlightPerHost, inFlight.get(host)!);
    res.on('close', () => inFlight.set(host, inFlight.get(host)! - 1));
    const route = routes.get(path.split('?')[0]!);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    await route(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  hits = [];
  inFlight = new Map();
  maxInFlightPerHost = 0;
  routes.clear();
});

const allow = () => parseAllowHosts({ get: <T>() => new URL(base).host as T });
const serveFeed = (path: string, body: string, etag = '"v1"') =>
  routes.set(path, (req, res) => {
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8', etag, 'last-modified': 'Sat, 21 Nov 2026 10:00:00 GMT' }).end(body);
  });

let detector: LanguageDetector;
before(async () => {
  detector = await createLanguageDetector();
});

function newStore(contact: string | null = 'reader@example.test') {
  const path = freshPath();
  const store = new Store(path);
  if (contact) store.setMeta(CONTACT_KEY, contact);
  const feed = (url: string, language: string | null = 'en') =>
    store.upsertFeed({
      feedUrl: url,
      publicationName: 'Example',
      publicationUrl: null,
      countryCode: 'GBR',
      feedLanguageCode: language,
      publisher: { name: new URL(url).pathname, countryCode: 'GBR', websiteUrl: null },
    }).id;
  return { path, store, feed };
}

const ingest = (store: Store, path: string, events: IngestEvent[] = []) =>
  runIngest({ store, dbPath: path, embedder: createFakeEmbedder(8), detector, allowHosts: allow(), gapMs: 50, onEvent: (e) => events.push(e) });

describe('ingest', () => {
  it('refuses to run until a contact is set, saying why', async () => {
    const { store, path } = newStore(null);
    await assert.rejects(ingest(store, path), (e: unknown) => e instanceof StoreError && e.code === 'contact_missing' && e.fix.startsWith('mera-news-local config set contact'));
    store.close();
  });

  it('stores each item once, keeps old items, and sends the contact in the user agent', async () => {
    serveFeed('/harbour.xml', HARBOUR);
    const { store, path, feed } = newStore();
    feed(`${base}/harbour.xml`);
    const first = await ingest(store, path);
    assert.deepEqual([first.feedsOk, first.feedsFailed, first.articlesNew], [1, 0, 3]);
    assert.equal(hits[0]!.headers['user-agent'], userAgentFor('reader@example.test'));
    const archive = store.db.prepare("SELECT pub_date FROM articles WHERE article_url LIKE '%archive'").get() as { pub_date: string };
    assert.equal(archive.pub_date, '2019-03-01T10:00:00.000Z');
    const second = await ingest(store, path);
    assert.equal(second.articlesNew, 0);
    assert.equal(store.articleCount(), 3);
    store.close();
  });

  it('asks again with the stored ETag and stores nothing on 304', async () => {
    serveFeed('/harbour.xml', HARBOUR);
    const { store, path, feed } = newStore();
    feed(`${base}/harbour.xml`);
    await ingest(store, path);
    const events: IngestEvent[] = [];
    await ingest(store, path, events);
    assert.equal(hits.at(-1)!.headers['if-none-match'], '"v1"');
    assert.equal(hits.at(-1)!.headers['if-modified-since'], 'Sat, 21 Nov 2026 10:00:00 GMT');
    assert.deepEqual(events.filter((e) => e.event === 'feed').map((e) => (e as { status: string }).status), ['not_modified']);
    store.close();
  });

  it('treats a tracking variant of a known address as the same article', async () => {
    serveFeed('/harbour.xml', HARBOUR);
    serveFeed('/mirror.xml', rss('Mirror', [{ title: 'Lighthouse reopens to visitors after three years of work', link: 'https://harbour.example.test/lighthouse', pubDate: now() }]));
    const { store, path, feed } = newStore();
    feed(`${base}/harbour.xml`);
    feed(`${base}/mirror.xml`);
    await ingest(store, path);
    assert.equal(store.articleCount(), 3);
    store.close();
  });

  it('fetches one feed at a time per host, a gap apart', async () => {
    const slow = (body: string) => async (_req: IncomingMessage, res: ServerResponse) => {
      await new Promise((r) => setTimeout(r, 80));
      res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(body);
    };
    routes.set('/a.xml', slow(rss('A', [{ title: 'Alpha headline about the harbour works', link: 'https://a.example.test/1', pubDate: now() }])));
    routes.set('/b.xml', slow(rss('B', [{ title: 'Beta headline about the city council', link: 'https://b.example.test/1', pubDate: now() }])));
    const { store, path, feed } = newStore();
    feed(`${base}/a.xml`);
    feed(`${base}/b.xml`);
    await ingest(store, path);
    assert.equal(maxInFlightPerHost, 1);
    const [first, second] = hits.map((h) => h.at);
    assert.ok(second! - first! >= 80 + 50 - 5, `requests ${second! - first!} ms apart`);
    store.close();
  });

  it('stores a Japanese feed so its headline can be found by text, in Japanese', async () => {
    serveFeed('/tokyo.xml', TOKYO);
    const { store, path, feed } = newStore();
    feed(`${base}/tokyo.xml`, 'ja');
    await ingest(store, path);
    const row = store.db
      .prepare('SELECT a.title, a.language_code FROM articles_fts f JOIN articles a ON a.rowid = f.rowid WHERE articles_fts MATCH ?')
      .get('電気バス') as { title: string; language_code: string };
    assert.equal(row.title, '東京で新しい電気バスが走り始めた');
    assert.equal(row.language_code, 'ja');
    store.close();
  });

  it('records a failed feed with its reason and goes on with the rest', async () => {
    serveFeed('/harbour.xml', HARBOUR);
    routes.set('/html', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>Not a feed</body></html>');
    });
    const { store, path, feed } = newStore();
    feed(`${base}/harbour.xml`);
    feed(`${base}/html`);
    feed(`${base}/missing.xml`);
    const summary = await ingest(store, path);
    assert.deepEqual([summary.feedsOk, summary.feedsFailed], [1, 2]);
    const failed = store.listFeeds().filter((f) => f.last_fetch_status === 'failed');
    assert.equal(failed.length, 2);
    assert.ok(failed.every((f) => f.last_fetch_error && f.http_etag === null));
    store.close();
  });

  it('names a feed added by address alone after its own title, and keeps a name given', async () => {
    serveFeed('/harbour.xml', HARBOUR);
    serveFeed('/tokyo.xml', TOKYO);
    const { store, path } = newStore();
    const add = (url: string, name: string) =>
      store.upsertFeed({ feedUrl: url, publicationName: name, publicationUrl: null, countryCode: null, feedLanguageCode: null, publisher: { name: name || '127.0.0.1', countryCode: null, websiteUrl: null } });
    add(`${base}/harbour.xml`, '');
    add(`${base}/tokyo.xml`, 'My Tokyo paper');
    await ingest(store, path);
    const names = Object.fromEntries(store.listFeeds().map((f) => [new URL(f.feed_url).pathname, f.publication_name]));
    assert.deepEqual(names, { '/harbour.xml': 'Harbour Gazette', '/tokyo.xml': 'My Tokyo paper' });
    add(`${base}/harbour.xml`, '');
    assert.equal(store.listFeeds().find((f) => f.feed_url.endsWith('/harbour.xml'))!.publication_name, 'Harbour Gazette');
    store.close();
  });

  it('takes the language a feed declares when none was given', async () => {
    serveFeed('/tokyo.xml', TOKYO);
    serveFeed('/short.xml', rss('Short', [{ title: 'Rates hold', link: 'https://short.example.test/1', pubDate: now() }], 'en-gb'));
    const { store, path, feed } = newStore();
    feed(`${base}/tokyo.xml`, null);
    feed(`${base}/short.xml`, null);
    await ingest(store, path);
    const langs = Object.fromEntries(store.listFeeds().map((f) => [new URL(f.feed_url).pathname, f.feed_language_code]));
    assert.deepEqual(langs, { '/tokyo.xml': 'ja', '/short.xml': 'en-gb' });
    store.close();
  });

  it('refuses a second writer while one holds the lock, naming its process', async () => {
    const { store, path, feed } = newStore();
    feed(`${base}/harbour.xml`);
    const release = acquireWriteLock(path);
    try {
      await assert.rejects(ingest(store, path), (e: unknown) => e instanceof StoreError && e.code === 'store_busy' && e.message.includes(String(process.pid)));
    } finally {
      release();
    }
    store.close();
  });

  it('takes over a lock left by a process that is gone', async () => {
    serveFeed('/harbour.xml', HARBOUR);
    const { store, path, feed } = newStore();
    feed(`${base}/harbour.xml`);
    writeFileSync(`${path}.lock`, '999999\n');
    const summary = await ingest(store, path);
    assert.equal(summary.feedsOk, 1);
    store.close();
  });
});

describe('fetch refusals', () => {
  const opts = () => ({ userAgent: 'test', allowHosts: allow() });

  it('refuses a scheme other than http or https', async () => {
    await assert.rejects(fetchFeed('file:///etc/passwd', opts()), (e: unknown) => e instanceof FetchError && e.code === 'refused');
  });

  it('refuses a private or loopback address that is not on the allow list', async () => {
    await assert.rejects(fetchFeed('http://127.0.0.1:9/feed', { userAgent: 'test' }), (e: unknown) => e instanceof FetchError && e.code === 'refused');
    await assert.rejects(fetchFeed('http://169.254.169.254/latest/meta-data/', { userAgent: 'test' }), (e: unknown) => e instanceof FetchError && e.code === 'refused');
  });

  it('refuses a redirect to a private address', async () => {
    routes.set('/hop', (_req, res) => {
      res.writeHead(302, { location: 'http://10.0.0.1/feed.xml' }).end();
    });
    await assert.rejects(fetchFeed(`${base}/hop`, opts()), (e: unknown) => e instanceof FetchError && e.code === 'refused');
    assert.equal(hits.length, 1);
  });

  it('checks every redirect hop, not only the first address', async () => {
    routes.set('/to-file', (_req, res) => {
      res.writeHead(302, { location: 'file:///etc/passwd' }).end();
    });
    await assert.rejects(fetchFeed(`${base}/to-file`, opts()), (e: unknown) => e instanceof FetchError && e.code === 'refused');
  });

  it('stops after five redirects', async () => {
    routes.set('/loop', (_req, res) => {
      res.writeHead(302, { location: '/loop' }).end();
    });
    await assert.rejects(fetchFeed(`${base}/loop`, opts()), (e: unknown) => e instanceof FetchError && e.code === 'too_many_redirects');
    assert.equal(hits.length, 6);
  });

  it('refuses a body over the byte cap, declared or streamed', async () => {
    routes.set('/big', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml', 'content-length': '5000' }).end('x'.repeat(5000));
    });
    routes.set('/stream', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.write('x'.repeat(3000));
      res.end('x'.repeat(3000));
    });
    await assert.rejects(fetchFeed(`${base}/big`, { ...opts(), maxBytes: 4096 }), (e: unknown) => e instanceof FetchError && e.code === 'too_large');
    await assert.rejects(fetchFeed(`${base}/stream`, { ...opts(), maxBytes: 4096 }), (e: unknown) => e instanceof FetchError && e.code === 'too_large');
  });

  it('gives up on a slow answer, body included', async () => {
    routes.set('/slow', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.write('<rss>');
      setTimeout(() => res.end('</rss>'), 1000);
    });
    await assert.rejects(fetchFeed(`${base}/slow`, { ...opts(), timeoutMs: 200 }), (e: unknown) => e instanceof FetchError && e.code === 'timeout');
  });

  it('does not expand entities declared in the feed', async () => {
    const lol = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;"><!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;"><!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;">]><rss version="2.0"><channel><title>t</title><item><title>&f;</title><link>https://x.example.test/1</link></item></channel></rss>`;
    const started = Date.now();
    const parsed = await parseFeed(new TextEncoder().encode(lol), 'application/rss+xml').catch((e: Error) => e);
    assert.ok(Date.now() - started < 1000);
    if (!(parsed instanceof Error)) {
      assert.ok(parsed.items.every((i) => i.title.length < 1000), 'entity text was expanded');
    }
  });
});
