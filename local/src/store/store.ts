import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './schema.ts';

/** A copy key joins an article only to a story whose article arrived within this window, as on the full server. */
export const STORY_WINDOW_HOURS = 48;

/** A refusal the person can act on: the same shape every command prints. */
export class StoreError extends Error {
  readonly code: string;
  readonly fix: string;
  constructor(code: string, message: string, fix: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.fix = fix;
  }
}

export interface PublisherInput {
  name: string;
  countryCode: string | null;
  websiteUrl: string | null;
}

export interface FeedInput {
  feedUrl: string;
  publicationName: string;
  publicationUrl: string | null;
  countryCode: string | null;
  feedLanguageCode: string | null;
  publisher: PublisherInput;
}

export interface FeedRow {
  id: string;
  publisher_id: string;
  feed_url: string;
  publication_name: string;
  publication_url: string | null;
  country_code: string | null;
  feed_language_code: string | null;
  is_active: number;
  http_etag: string | null;
  http_last_modified: string | null;
  last_fetch_at: string | null;
  last_fetch_status: string | null;
  last_fetch_error: string | null;
  consecutive_failures: number;
}

export interface FetchRecord {
  at: string;
  status: 'ok' | 'not_modified' | 'failed' | 'refused';
  etag?: string | null;
  lastModified?: string | null;
  error?: string | null;
}

export interface ArticleInput {
  /** The address as the feed gives it, trimmed. */
  articleUrl: string;
  /** Scheme- and tracking-independent key of the address; once seen it never comes back. */
  fingerprint: string;
  copyKeys: string[];
  title: string;
  description: string | null;
  imageUrl: string | null;
  languageCode: string | null;
  /** UTC ISO, from normalizePubDate. */
  pubDate: string;
  vector: Float32Array;
}

export interface EmbeddingModel {
  id: string;
  dims: number;
}

export interface IntegrityProblem {
  code: string;
  message: string;
  fix: string;
}

/** 24 hex characters: 4 bytes of seconds, then 8 random bytes, so ids sort by creation. */
export function newId(at: Date = new Date()): string {
  const seconds = Math.floor(at.getTime() / 1000);
  return seconds.toString(16).padStart(8, '0') + randomBytes(8).toString('hex');
}

export function encodeVector(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function decodeVector(blob: Uint8Array): Float32Array {
  // Copy: a blob from SQLite need not be aligned for Float32 reads.
  return new Float32Array(blob.slice().buffer);
}

/** Opens the file and brings it to the newest schema, one migration per transaction. */
export function migrate(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > migrations.length) {
    throw new StoreError(
      'store_too_old',
      `This news file was made by a newer mera-news-local (schema ${current}, this one knows ${migrations.length}).`,
      'npm install in the mera-news-local folder to update it, then run the command again',
    );
  }
  for (let version = current; version < migrations.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string, migrations: readonly string[] = MIGRATIONS) {
    this.db = new DatabaseSync(path);
    // WAL and a busy timeout, so `serve` can read while one ingest writes.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    try {
      migrate(this.db, migrations);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /** The model the stored vectors were made with, or null before the first vector. */
  embeddingModel(): EmbeddingModel | null {
    const id = this.getMeta('embedding_model');
    const dims = this.getMeta('embedding_dims');
    return id && dims ? { id, dims: Number(dims) } : null;
  }

  /**
   * Refuses a model other than the one the stored vectors were made with. An empty store
   * takes the model it is first given.
   */
  assertEmbeddingModel(model: EmbeddingModel): void {
    const stored = this.embeddingModel();
    if (!stored) {
      this.setMeta('embedding_model', model.id);
      this.setMeta('embedding_dims', String(model.dims));
      return;
    }
    if (stored.id !== model.id || stored.dims !== model.dims) {
      throw new StoreError(
        'wrong_model',
        `The stored articles were embedded with ${stored.id} (${stored.dims} dimensions), not ${model.id} (${model.dims}).`,
        `mera-news-local reembed --model ${model.id}`,
      );
    }
  }

  upsertPublisher(input: PublisherInput, at = new Date().toISOString()): string {
    const found = this.db
      .prepare('SELECT id FROM publishers WHERE name = ? AND country_code IS ?')
      .get(input.name, input.countryCode) as { id: string } | undefined;
    if (found) return found.id;
    const id = newId();
    this.db
      .prepare('INSERT INTO publishers (id, name, country_code, website_url, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name, input.countryCode, input.websiteUrl, at);
    return id;
  }

  /** Matched by feed address; a repeat updates the names and keeps the fetch state. */
  upsertFeed(input: FeedInput, at = new Date().toISOString()): { id: string; created: boolean } {
    return this.transaction(() => {
      const publisherId = this.upsertPublisher(input.publisher, at);
      const found = this.db.prepare('SELECT id FROM feeds WHERE feed_url = ?').get(input.feedUrl) as
        | { id: string }
        | undefined;
      if (found) {
        this.db
          .prepare(
            `UPDATE feeds SET publisher_id = ?, publication_name = ?, publication_url = ?, country_code = ?,
               feed_language_code = ?, updated_at = ? WHERE id = ?`,
          )
          .run(publisherId, input.publicationName, input.publicationUrl, input.countryCode, input.feedLanguageCode, at, found.id);
        return { id: found.id, created: false };
      }
      const id = newId();
      this.db
        .prepare(
          `INSERT INTO feeds (id, publisher_id, feed_url, publication_name, publication_url, country_code,
             feed_language_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, publisherId, input.feedUrl, input.publicationName, input.publicationUrl, input.countryCode, input.feedLanguageCode, at, at);
      return { id, created: true };
    });
  }

  listFeeds(options: { activeOnly?: boolean } = {}): FeedRow[] {
    const where = options.activeOnly ? 'WHERE is_active = 1' : '';
    return this.db.prepare(`SELECT * FROM feeds ${where} ORDER BY feed_url`).all() as unknown as FeedRow[];
  }

  /** A fetch that wrote no items: not modified, failed or refused. */
  recordFetch(feedId: string, record: FetchRecord): void {
    this.transaction(() => this.writeFetch(feedId, record));
  }

  /**
   * One feed's new items, their vectors and the feed's ETag and Last-Modified, in one
   * transaction, so the conditional-request state never runs ahead of the items. Items whose
   * address was seen before are skipped.
   */
  writeFeedFetch(
    feedId: string,
    items: ArticleInput[],
    record: FetchRecord,
    runId: string | null,
  ): { inserted: { id: string; storyKey: string }[]; duplicates: number } {
    return this.transaction(() => {
      const inserted: { id: string; storyKey: string }[] = [];
      let duplicates = 0;
      for (const item of items) {
        const result = this.insertArticle(feedId, item, record.at, runId);
        if (result) inserted.push(result);
        else duplicates++;
      }
      this.writeFetch(feedId, record);
      return { inserted, duplicates };
    });
  }

  private writeFetch(feedId: string, record: FetchRecord): void {
    const failed = record.status === 'failed' || record.status === 'refused';
    this.db
      .prepare(
        `UPDATE feeds SET last_fetch_at = ?, last_fetch_status = ?, last_fetch_error = ?,
           http_etag = COALESCE(?, http_etag), http_last_modified = COALESCE(?, http_last_modified),
           consecutive_failures = CASE WHEN ? THEN consecutive_failures + 1 ELSE 0 END,
           updated_at = ? WHERE id = ?`,
      )
      .run(record.at, record.status, record.error ?? null, record.etag ?? null, record.lastModified ?? null, failed ? 1 : 0, record.at, feedId);
  }

  /** Its story key is the oldest story a copy key points at within the window, otherwise its own id. */
  private insertArticle(
    feedId: string,
    input: ArticleInput,
    createdAt: string,
    runId: string | null,
  ): { id: string; storyKey: string } | null {
    const seen = this.db
      .prepare('INSERT INTO fingerprints (key, first_seen) VALUES (?, ?) ON CONFLICT DO NOTHING')
      .run(input.fingerprint, createdAt);
    if (seen.changes === 0) return null;

    // A different address can still be stored under the same unique column; treat it as seen.
    const sameUrl = this.db.prepare('SELECT 1 FROM articles WHERE article_url = ?').get(input.articleUrl);
    if (sameUrl) return null;
    const id = newId(new Date(createdAt));
    const keys = [...new Set(input.copyKeys)];
    let storyKey = id;
    if (keys.length > 0) {
      const since = new Date(Date.parse(createdAt) - STORY_WINDOW_HOURS * 3600_000).toISOString();
      const row = this.db
        .prepare(
          `SELECT MIN(a.story_key) AS story_key FROM copy_keys c JOIN articles a ON a.id = c.article_id
           WHERE c.key IN (${keys.map(() => '?').join(',')}) AND a.created_at >= ?`,
        )
        .get(...keys, since) as { story_key: string | null };
      if (row.story_key) storyKey = row.story_key;
    }

    this.db
      .prepare(
        `INSERT INTO articles (id, feed_id, article_url, title, description, image_url, language_code,
           pub_date, created_at, run_id, story_key, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, feedId, input.articleUrl, input.title, input.description, input.imageUrl, input.languageCode, input.pubDate, createdAt, runId, storyKey, encodeVector(input.vector));
    const addKey = this.db.prepare('INSERT INTO copy_keys (key, article_id) VALUES (?, ?) ON CONFLICT DO NOTHING');
    for (const key of keys) addKey.run(key, id);
    return { id, storyKey };
  }

  /** Which of these fingerprints the file has seen, so known items are not embedded again. */
  knownFingerprints(keys: string[]): Set<string> {
    const known = new Set<string>();
    const lookup = this.db.prepare('SELECT 1 FROM fingerprints WHERE key = ?');
    for (const key of keys) if (lookup.get(key)) known.add(key);
    return known;
  }

  /** Articles a reembed to the new model has not reached yet. */
  pendingReembed(limit: number): { id: string; title: string; description: string | null }[] {
    return this.db
      .prepare('SELECT id, title, description FROM articles WHERE embedding_next IS NULL ORDER BY rowid LIMIT ?')
      .all(limit) as unknown as { id: string; title: string; description: string | null }[];
  }

  /**
   * Starts or resumes a reembed. A different target than the one in progress throws the
   * partial work away. The old vectors stay in use until finishReembed.
   */
  beginReembed(model: EmbeddingModel): void {
    const target = this.getMeta('reembed_model');
    const wanted = `${model.id}:${model.dims}`;
    if (target === wanted) return;
    this.transaction(() => {
      this.db.prepare('UPDATE articles SET embedding_next = NULL').run();
      this.setMeta('reembed_model', wanted);
    });
  }

  setNextEmbeddings(rows: { id: string; vector: Float32Array }[]): void {
    this.transaction(() => {
      const update = this.db.prepare('UPDATE articles SET embedding_next = ? WHERE id = ?');
      for (const row of rows) update.run(encodeVector(row.vector), row.id);
    });
  }

  /** Swaps every new vector in at once and records the new model. */
  finishReembed(model: EmbeddingModel): void {
    this.transaction(() => {
      const left = this.db.prepare('SELECT COUNT(*) AS n FROM articles WHERE embedding_next IS NULL').get() as { n: number };
      if (left.n > 0) throw new Error(`${left.n} articles have no new vector yet`);
      this.db.prepare('UPDATE articles SET embedding = embedding_next, embedding_next = NULL').run();
      this.setMeta('embedding_model', model.id);
      this.setMeta('embedding_dims', String(model.dims));
      this.db.prepare("DELETE FROM meta WHERE key = 'reembed_model'").run();
    });
  }

  startRun(at = new Date().toISOString()): string {
    const id = newId(new Date(at));
    this.db.prepare('INSERT INTO ingest_runs (id, started_at) VALUES (?, ?)').run(id, at);
    return id;
  }

  finishRun(runId: string, counts: { feedsOk: number; feedsFailed: number; articlesNew: number }, at = new Date().toISOString()): void {
    this.db
      .prepare('UPDATE ingest_runs SET finished_at = ?, feeds_ok = ?, feeds_failed = ?, articles_new = ? WHERE id = ?')
      .run(at, counts.feedsOk, counts.feedsFailed, counts.articlesNew, runId);
  }

  /** When the last finished ingest ended: every window in local mode counts back from here, never from now. */
  lastIngestAt(): string | null {
    const row = this.db
      .prepare('SELECT MAX(finished_at) AS at FROM ingest_runs WHERE finished_at IS NOT NULL')
      .get() as { at: string | null };
    return row.at;
  }

  articleCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM articles').get() as { n: number }).n;
  }

  /** What `status` reports as problems, each with the command that fixes it. */
  integrityProblems(): IntegrityProblem[] {
    const problems: IntegrityProblem[] = [];
    const model = this.embeddingModel();
    if (model) {
      const wrong = this.db
        .prepare('SELECT COUNT(*) AS n FROM articles WHERE length(embedding) != ?')
        .get(model.dims * 4) as { n: number };
      if (wrong.n > 0) {
        problems.push({
          code: 'vectors_mismatched',
          message: `${wrong.n} articles have a vector of another size than ${model.id} makes.`,
          fix: `mera-news-local reembed --model ${model.id}`,
        });
      }
    } else if (this.articleCount() > 0) {
      problems.push({
        code: 'model_unrecorded',
        message: 'The file holds articles but does not say which model embedded them.',
        fix: 'mera-news-local reembed',
      });
    }
    const target = this.getMeta('reembed_model');
    if (target) {
      problems.push({
        code: 'reembed_unfinished',
        message: `A change of model to ${target.split(':')[0]} did not finish. Search still uses the old vectors.`,
        fix: `mera-news-local reembed --model ${target.split(':')[0]}`,
      });
    }
    return problems;
  }

  /** Deletes articles published before the date. Their addresses stay known, so they never come back. */
  prune(olderThan: string): number {
    return Number(this.db.prepare('DELETE FROM articles WHERE pub_date < ?').run(olderThan).changes);
  }
}

export function openStore(path: string): Store {
  return new Store(path);
}
