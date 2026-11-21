import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, describe, it } from 'node:test';
import { normalizePubDate } from '../src/store/dates.ts';
import { MIGRATIONS } from '../src/store/schema.ts';
import { Store, StoreError, decodeVector, newId, type ArticleInput } from '../src/store/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'mera-news-local-store-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const freshPath = () => join(dir, `news-${++n}.db`);

const MODEL = { id: 'test-model', dims: 4 };
const vec = (...values: number[]) => new Float32Array(values);
const feedInput = (url: string) => ({
  feedUrl: url,
  publicationName: 'Harbour Gazette',
  publicationUrl: 'https://harbour.example.test',
  countryCode: 'GBR',
  feedLanguageCode: 'en',
  publisher: { name: 'Harbour Gazette', countryCode: 'GBR', websiteUrl: 'https://harbour.example.test' },
});
const item = (url: string, overrides: Partial<ArticleInput> = {}): ArticleInput => ({
  articleUrl: url,
  copyKeys: [],
  title: `Headline for ${url}`,
  description: 'A description',
  imageUrl: null,
  languageCode: 'en',
  pubDate: new Date().toISOString(),
  vector: vec(1, 0, 0, 0),
  ...overrides,
});
const ok = (at = new Date().toISOString()) => ({ at, status: 'ok' as const, etag: '"v1"', lastModified: 'Sat, 21 Nov 2026 10:00:00 GMT' });

describe('the news file', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(freshPath());
  });

  it('comes up at the newest schema version in WAL mode', () => {
    assert.equal((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
    assert.equal((store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    store.close();
  });

  it('makes ids of 24 hex characters that sort by time', () => {
    const a = newId(new Date('2026-01-01T00:00:00Z'));
    const b = newId(new Date('2026-06-01T00:00:00Z'));
    assert.match(a, /^[0-9a-f]{24}$/);
    assert.ok(a < b);
    store.close();
  });

  it('keeps one row per feed address and one publisher per name and country', () => {
    const first = store.upsertFeed(feedInput('https://harbour.example.test/rss'));
    const again = store.upsertFeed({ ...feedInput('https://harbour.example.test/rss'), publicationName: 'Renamed' });
    store.upsertFeed(feedInput('https://harbour.example.test/sport.xml'));
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.id, first.id);
    const feeds = store.listFeeds();
    assert.equal(feeds.length, 2);
    assert.equal(new Set(feeds.map((f) => f.publisher_id)).size, 1);
    assert.equal(feeds.find((f) => f.id === first.id)!.publication_name, 'Renamed');
    store.close();
  });

  it('writes items, vectors and the conditional-request state together, and never stores an address twice', () => {
    const feed = store.upsertFeed(feedInput('https://harbour.example.test/rss')).id;
    const first = store.writeFeedFetch(feed, [item('https://harbour.example.test/a'), item('https://harbour.example.test/b')], ok(), null);
    const second = store.writeFeedFetch(feed, [item('https://harbour.example.test/a'), item('https://harbour.example.test/c')], ok(), null);
    assert.equal(first.inserted.length, 2);
    assert.equal(second.inserted.length, 1);
    assert.equal(second.duplicates, 1);
    assert.equal(store.articleCount(), 3);
    const row = store.listFeeds()[0];
    assert.equal(row.http_etag, '"v1"');
    assert.equal(row.last_fetch_status, 'ok');
    const stored = store.db.prepare('SELECT embedding FROM articles LIMIT 1').get() as { embedding: Uint8Array };
    assert.deepEqual([...decodeVector(stored.embedding)], [1, 0, 0, 0]);
    store.close();
  });

  it('keeps the old ETag when a write fails half way', () => {
    const feed = store.upsertFeed(feedInput('https://harbour.example.test/rss')).id;
    store.writeFeedFetch(feed, [item('https://harbour.example.test/a')], ok(), null);
    const broken = item('https://harbour.example.test/b', { title: null as unknown as string });
    assert.throws(() => store.writeFeedFetch(feed, [broken], { ...ok(), etag: '"v2"' }, null));
    assert.equal(store.listFeeds()[0].http_etag, '"v1"');
    assert.equal(store.articleCount(), 1);
    store.close();
  });

  it('never takes an address back after a prune', () => {
    const feed = store.upsertFeed(feedInput('https://harbour.example.test/rss')).id;
    store.writeFeedFetch(feed, [item('https://harbour.example.test/old', { pubDate: '2026-01-01T00:00:00.000Z' })], ok(), null);
    assert.equal(store.prune('2026-02-01T00:00:00.000Z'), 1);
    const again = store.writeFeedFetch(feed, [item('https://harbour.example.test/old')], ok(), null);
    assert.equal(again.inserted.length, 0);
    assert.equal(store.articleCount(), 0);
    store.close();
  });

  it('gives a copy the story key of the oldest story its copy keys point at', () => {
    const feed = store.upsertFeed(feedInput('https://harbour.example.test/rss')).id;
    const a = store.writeFeedFetch(feed, [item('https://harbour.example.test/a', { copyKeys: ['url:a'] })], ok(), null).inserted[0];
    const b = store.writeFeedFetch(feed, [item('https://harbour.example.test/b', { copyKeys: ['url:b'] })], ok(), null).inserted[0];
    const copy = store.writeFeedFetch(feed, [item('https://mirror.example.test/a', { copyKeys: ['url:b', 'url:a'] })], ok(), null).inserted[0];
    const alone = store.writeFeedFetch(feed, [item('https://harbour.example.test/c', { copyKeys: ['url:c'] })], ok(), null).inserted[0];
    assert.equal(copy.storyKey, [a.id, b.id].sort()[0]);
    assert.equal(alone.storyKey, alone.id);
    store.close();
  });

  it('does not join a story older than the window', () => {
    const feed = store.upsertFeed(feedInput('https://harbour.example.test/rss')).id;
    const then = '2026-01-01T00:00:00.000Z';
    const old = store.writeFeedFetch(feed, [item('https://harbour.example.test/a', { copyKeys: ['url:a'] })], ok(then), null).inserted[0];
    const later = store.writeFeedFetch(feed, [item('https://mirror.example.test/a', { copyKeys: ['url:a'] })], ok('2026-01-05T00:00:00.000Z'), null).inserted[0];
    assert.notEqual(later.storyKey, old.storyKey);
    store.close();
  });

  it('finds headlines by text in any script, accents ignored', () => {
    const feed = store.upsertFeed(feedInput('https://harbour.example.test/rss')).id;
    store.writeFeedFetch(
      feed,
      [
        item('https://harbour.example.test/ja', { title: '東京で新しい電気バスが走り始めた', languageCode: 'ja' }),
        item('https://harbour.example.test/fr', { title: 'Électricité rétablie à Paris', languageCode: 'fr' }),
      ],
      ok(),
      null,
    );
    const match = (q: string) =>
      (store.db.prepare('SELECT a.title FROM articles_fts f JOIN articles a ON a.rowid = f.rowid WHERE articles_fts MATCH ?').all(q) as { title: string }[]).map((r) => r.title);
    assert.deepEqual(match('電気バス'), ['東京で新しい電気バスが走り始めた']);
    assert.deepEqual(match('electricite'), ['Électricité rétablie à Paris']);
    store.prune('2100-01-01T00:00:00.000Z');
    assert.deepEqual(match('電気バス'), []);
    store.close();
  });

  it('takes the first model it is given and refuses another, naming reembed', () => {
    store.assertEmbeddingModel(MODEL);
    store.assertEmbeddingModel(MODEL);
    assert.throws(
      () => store.assertEmbeddingModel({ id: 'other', dims: 8 }),
      (error: unknown) => error instanceof StoreError && error.code === 'wrong_model' && error.fix.includes('reembed'),
    );
    store.close();
  });

  it('reembeds beside the old vectors and swaps them at the end, across a change of size', () => {
    store.assertEmbeddingModel(MODEL);
    const feed = store.upsertFeed(feedInput('https://harbour.example.test/rss')).id;
    store.writeFeedFetch(feed, [item('https://harbour.example.test/a'), item('https://harbour.example.test/b')], ok(), null);
    const next = { id: 'bigger', dims: 8 };

    store.beginReembed(next);
    const [first] = store.pendingReembed(1);
    store.setNextEmbeddings([{ id: first.id, vector: new Float32Array(8).fill(0.5) }]);
    // A crash here leaves the old set whole and in use.
    assert.throws(() => store.finishReembed(next), /1 articles have no new vector/);
    assert.deepEqual(store.embeddingModel(), MODEL);
    assert.ok(store.integrityProblems().some((p) => p.code === 'reembed_unfinished'));

    store.beginReembed(next); // resume keeps the work done
    const rest = store.pendingReembed(10);
    assert.equal(rest.length, 1);
    store.setNextEmbeddings(rest.map((r) => ({ id: r.id, vector: new Float32Array(8).fill(0.25) })));
    store.finishReembed(next);

    assert.deepEqual(store.embeddingModel(), next);
    assert.deepEqual(store.integrityProblems(), []);
    const sizes = store.db.prepare('SELECT length(embedding) AS n FROM articles').all() as { n: number }[];
    assert.deepEqual(sizes.map((s) => s.n), [32, 32]);
    store.close();
  });

  it('counts every window back from the last finished ingest', () => {
    assert.equal(store.lastIngestAt(), null);
    const run = store.startRun('2026-11-01T10:00:00.000Z');
    assert.equal(store.lastIngestAt(), null);
    store.finishRun(run, { feedsOk: 1, feedsFailed: 0, articlesNew: 2 }, '2026-11-01T10:05:00.000Z');
    assert.equal(store.lastIngestAt(), '2026-11-01T10:05:00.000Z');
    store.close();
  });
});

describe('schema versions', () => {
  it('upgrades a file made by an older version, keeping its rows', () => {
    const path = freshPath();
    const old = new Store(path, MIGRATIONS);
    old.setMeta('kept', 'yes');
    old.close();
    const next = [...MIGRATIONS, "CREATE TABLE extra (x TEXT) STRICT; INSERT INTO meta (key, value) VALUES ('upgraded', 'yes');"];
    const upgraded = new Store(path, next);
    assert.equal((upgraded.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, next.length);
    assert.equal(upgraded.getMeta('kept'), 'yes');
    assert.equal(upgraded.getMeta('upgraded'), 'yes');
    upgraded.close();
  });

  it('refuses a file made by a newer version', () => {
    const path = freshPath();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    assert.throws(
      () => new Store(path),
      (error: unknown) => error instanceof StoreError && error.code === 'store_too_old',
    );
  });

  it('rolls back a migration that fails, leaving the version where it was', () => {
    const path = freshPath();
    new Store(path).close();
    assert.throws(() => new Store(path, [...MIGRATIONS, 'CREATE TABLE broken (']));
    const db = new DatabaseSync(path);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, MIGRATIONS.length);
    db.close();
  });
});

describe('publish dates', () => {
  const seen = new Date('2026-11-21T12:00:00.000Z');
  it('stores UTC', () => {
    assert.equal(normalizePubDate('Sat, 21 Nov 2026 13:00:00 +0200', seen), '2026-11-21T11:00:00.000Z');
  });
  it('takes the first-seen time for a missing or unreadable date', () => {
    assert.equal(normalizePubDate(undefined, seen), seen.toISOString());
    assert.equal(normalizePubDate('not a date', seen), seen.toISOString());
  });
  it('clamps a date in the future to the first-seen time', () => {
    assert.equal(normalizePubDate('2027-01-01T00:00:00Z', seen), seen.toISOString());
  });
  it('skips an item older than the ingest cutoff, as the full server does', () => {
    assert.equal(normalizePubDate('2026-11-10T00:00:00Z', seen), null);
    assert.equal(normalizePubDate('2026-11-15T00:00:00Z', seen), '2026-11-15T00:00:00.000Z');
  });
});
