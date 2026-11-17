import { Logger } from '@nestjs/common';
import { createClient } from 'redis';

/**
 * Redis scratchpad for the ID-array ingestion pipeline.
 *
 * Each article accumulates its intermediate delta here as it moves through
 * translate → embed → project. The terminal `database-projector` job flushes the
 * finished entries to Mongo in ONE bulkWrite and DELetes the confirmed keys, so
 * article data touches Mongo exactly once on the happy path (insert + project).
 *
 * WHY A DEDICATED THIN CLIENT (not the cache-manager Keyv layer)
 * --------------------------------------------------------------
 * This service needs MGET / pipelined-SET / DEL semantics over the SAME shared
 * `news-persistent-redis` instance the fingerprint cache uses (env
 * `PERSISTENT_REDIS_URL`, fallback `REDIS_URL`). cache-manager v7 exposes only
 * get/set/del one key at a time, so a direct node-redis client (already a repo
 * dependency) is used here. Keys are namespaced exactly like the Keyv cache
 * (`<namespace>:article-cache:{id}`) so staging (`stg:`) and prod stay isolated
 * on the shared instance.
 *
 * VECTOR CODEC: the two 768-dim Float32 vectors dominate the entry size. They
 * are stored base64-encoded Float32 (~3× smaller than JSON number arrays) and
 * decoded transparently on read. TTL (default 24 h) is a leak backstop — the
 * projector normally DELetes keys the moment they land in Mongo.
 */

/** Minimal surface of the redis client used here — lets tests inject a fake. */
export interface ArticleCacheRedisClient {
  isOpen?: boolean;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  mGet(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, options?: { PX?: number }): Promise<unknown>;
  del(keys: string[]): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * The accumulated per-article delta. Written incrementally by the translate and
 * embed steps, read whole by the projector. Vectors are `number[]` in memory;
 * the codec base64-Float32-encodes them on the wire.
 */
export interface ArticleCacheEntry {
  articleId: string;
  // --- translation delta ---
  title_en_internal_only?: string;
  description_en_internal_only?: string;
  embedding_text_source?: 'english_original' | 'english_translation';
  translationSkipReason?: string;
  /** ISO timestamp captured by the translate step. */
  translationCompletedAt?: string;
  /**
   * Per-article CLD3 self-correction (truthful language labels).
   * Set only when the translate step's per-article detection disagrees with
   * the language code stamped at ingest (e.g. an unreliable `en*` RSS feed
   * declaration). Carried through untouched by the embed step so the
   * projector can correct `NewsArticle.original_language_code`.
   */
  original_language_code?: string;
  // --- embedding delta ---
  retrievalVector?: number[];
  textMatchingVector?: number[];
  /**
   * Packed sign-bit sidecar of `retrievalVector` (base64 of the 96-byte
   * buffer `packSignBits` produces — see `@mera/shared/vector/pack-sign-bits`
   * for the bit-order contract). Already base64 by the time it lands here, so
   * unlike the two vectors above it needs no further (de)serialization codec.
   */
  vectorSidecarPacked?: string;
  /** ISO timestamp captured by the embed step. */
  embeddingCompletedAt?: string;
  /** Confident canonical L1 topics from the embed step (linked by the projector). */
  canonical_links?: { topicId: string; confidence: number }[];
}

export interface ArticleCacheServiceOptions {
  /** Redis URL (`PERSISTENT_REDIS_URL` ?? `REDIS_URL`). */
  url?: string;
  /** Already-normalized key namespace (e.g. `stg`); undefined = no prefix. */
  namespace?: string;
  /** Entry TTL in ms (leak backstop). */
  ttlMs: number;
}

const KEY_PREFIX = 'article-cache:';

/** base64-encode a Float32 view of a plain number array. */
export function encodeVector(vector: number[]): string {
  const f32 = Float32Array.from(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString(
    'base64',
  );
}

/** Decode a base64 Float32 blob back into a plain number array. */
export function decodeVector(encoded: string): number[] {
  const buf = Buffer.from(encoded, 'base64');
  const f32 = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    Math.floor(buf.byteLength / 4),
  );
  return Array.from(f32);
}

/** On-wire JSON shape (vectors base64) — internal to (de)serialization. */
interface WireEntry {
  articleId: string;
  title_en_internal_only?: string;
  description_en_internal_only?: string;
  embedding_text_source?: 'english_original' | 'english_translation';
  translationSkipReason?: string;
  translationCompletedAt?: string;
  original_language_code?: string;
  embeddingCompletedAt?: string;
  retrieval?: string;
  textMatching?: string;
  vectorSidecarPacked?: string;
  canonical_links?: { topicId: string; confidence: number }[];
}

export class ArticleCacheService {
  private readonly logger = new Logger(ArticleCacheService.name);
  private readonly client: ArticleCacheRedisClient;
  private readonly ttlMs: number;
  private readonly namespace?: string;
  private connectPromise?: Promise<unknown>;

  constructor(
    options: ArticleCacheServiceOptions,
    client?: ArticleCacheRedisClient,
  ) {
    this.ttlMs = options.ttlMs;
    this.namespace = options.namespace;
    this.client =
      client ??
      (createClient({
        url: options.url,
        // node-redis 6 defaults to RESP3, which reshapes replies; keep v5's.
        RESP: 2,
      }) as unknown as ArticleCacheRedisClient);

    // An unhandled 'error' event crashes Node — swallow + log so a transient
    // Redis outage degrades to "cache miss" (Mongo remains the authority) rather
    // than killing the worker.
    this.client.on('error', (err: unknown) => {
      this.logger.warn(
        `Article cache Redis error (degrading to Mongo): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  /** Build the on-wire key for an article id, honoring the env namespace. */
  key(articleId: string): string {
    return this.namespace
      ? `${this.namespace}:${KEY_PREFIX}${articleId}`
      : `${KEY_PREFIX}${articleId}`;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isOpen) return;
    if (!this.connectPromise) {
      this.connectPromise = this.client.connect().catch((err) => {
        // Reset so a later call can retry the connection.
        this.connectPromise = undefined;
        throw err;
      });
    }
    await this.connectPromise;
  }

  /** Fetch one entry, or null if absent. */
  async get(articleId: string): Promise<ArticleCacheEntry | null> {
    const found = await this.getMany([articleId]);
    return found.get(articleId) ?? null;
  }

  /**
   * MGET a batch of entries. Missing / unparseable keys are simply absent from
   * the returned map (never throws for a single bad value).
   */
  async getMany(articleIds: string[]): Promise<Map<string, ArticleCacheEntry>> {
    const result = new Map<string, ArticleCacheEntry>();
    if (articleIds.length === 0) return result;
    await this.ensureConnected();
    const keys = articleIds.map((id) => this.key(id));
    const values = await this.client.mGet(keys);
    values.forEach((raw, i) => {
      if (!raw) return;
      const entry = this.deserialize(raw);
      if (entry) result.set(articleIds[i], entry);
    });
    return result;
  }

  /**
   * Pipelined SET of a batch of entries with the configured TTL. node-redis
   * auto-pipelines commands issued in the same tick, so the Promise.all below is
   * a single round-trip batch.
   */
  async setMany(entries: ArticleCacheEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.ensureConnected();
    await Promise.all(
      entries.map((entry) =>
        this.client.set(this.key(entry.articleId), this.serialize(entry), {
          PX: this.ttlMs,
        }),
      ),
    );
  }

  /** DEL a batch of keys (single command). */
  async delMany(articleIds: string[]): Promise<void> {
    if (articleIds.length === 0) return;
    await this.ensureConnected();
    await this.client.del(articleIds.map((id) => this.key(id)));
  }

  /** Close the underlying connection (called on module shutdown). */
  async close(): Promise<void> {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  private serialize(entry: ArticleCacheEntry): string {
    const wire: WireEntry = {
      articleId: entry.articleId,
      title_en_internal_only: entry.title_en_internal_only,
      description_en_internal_only: entry.description_en_internal_only,
      embedding_text_source: entry.embedding_text_source,
      translationSkipReason: entry.translationSkipReason,
      translationCompletedAt: entry.translationCompletedAt,
      original_language_code: entry.original_language_code,
      embeddingCompletedAt: entry.embeddingCompletedAt,
      retrieval: entry.retrievalVector
        ? encodeVector(entry.retrievalVector)
        : undefined,
      textMatching: entry.textMatchingVector
        ? encodeVector(entry.textMatchingVector)
        : undefined,
      vectorSidecarPacked: entry.vectorSidecarPacked,
      canonical_links: entry.canonical_links,
    };
    return JSON.stringify(wire);
  }

  private deserialize(raw: string): ArticleCacheEntry | null {
    try {
      const wire = JSON.parse(raw) as WireEntry;
      return {
        articleId: wire.articleId,
        title_en_internal_only: wire.title_en_internal_only,
        description_en_internal_only: wire.description_en_internal_only,
        embedding_text_source: wire.embedding_text_source,
        translationSkipReason: wire.translationSkipReason,
        translationCompletedAt: wire.translationCompletedAt,
        original_language_code: wire.original_language_code,
        embeddingCompletedAt: wire.embeddingCompletedAt,
        retrievalVector: wire.retrieval
          ? decodeVector(wire.retrieval)
          : undefined,
        textMatchingVector: wire.textMatching
          ? decodeVector(wire.textMatching)
          : undefined,
        vectorSidecarPacked: wire.vectorSidecarPacked,
        canonical_links: wire.canonical_links,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to parse article cache entry (treating as miss): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
}
