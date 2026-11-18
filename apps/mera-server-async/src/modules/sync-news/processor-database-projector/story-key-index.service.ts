/**
 * Write-once `story_key` for every projected article: the `_id` of the story's
 * seed article. The phone groups its feed by it and scores one article per
 * story.
 *
 * Two layers, in order. Layer 1: an exact copy key (`copy_keys`, stamped at
 * ingest) already carried by a live article joins its story; when the keys
 * point at different stories the oldest story (lowest key, i.e. earliest seed
 * ObjectId) wins. Layer 2: the first
 * SEED (an article that minted its own key) within `HAMMING_BAR` of the
 * text-matching sign bits, ingested within `NEAR_DUP_WINDOW_S` and not from the
 * same publisher (or feed). Only seeds are scanned, so a story never chains
 * through its members. Otherwise the article mints its own `_id`. Layer 2 is
 * off when `HAMMING_BAR <= 0`, and an article whose English text is under
 * `MIN_TEXT_CHARS` neither searches it nor becomes a seed (layer 1 still
 * applies to it). Layer 2 runs only for the calibrated embedding model
 * (`isCalibratedEmbedding`).
 *
 * In memory, one process: a ring of `RING_CAPACITY` slots plus copy-key and id
 * maps, rebuilt at boot from a narrow 48h `_id`-range stream. A second
 * news-async process (rollout overlap, a local `npm run async`) only fragments
 * stories, never merges wrongly: every key is either the article's own `_id` or
 * one this process matched.
 *
 * The key reaches the row through this service's own guarded bulkWrite
 * (`keyOp`, pipeline `$ifNull`, write-once) after the projector's projection op
 * has committed, never inside it. Projection must never wait on the index, so an
 * article is projected but keyless for seconds (a failed write until the next
 * boot backfill); clustering runs at :10, long after.
 *
 * Never gates projection: the projector calls `submit()` without awaiting,
 * after its DEL and enrichment enqueue. Rebuild, assignment and the hourly sweep
 * share ONE promise chain, so a live article cannot scan the ring before the
 * rebuild has streamed in its older seed. Invariant: the scan and the insert of
 * one article never cross an await, so copies in one batch see each other.
 */
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'crypto';
import { performance } from 'perf_hooks';
import { AnyBulkWriteOperation, Model, Types } from 'mongoose';
import {
  NewsArticle,
  NewsArticleDocument,
} from '@mera/models/models/news-article.model';
import {
  PublicationSource,
  PublicationSourceDocument,
} from '@mera/models/models/publication-source.model';
import { JobLogger } from '@mera/shared';
import { isCalibratedEmbedding } from '@mera/shared/embedding-provider/embedding-config';
import {
  enTextChars,
  HAMMING_BAR,
  MIN_TEXT_CHARS,
  NEAR_DUP_EXCLUSION,
  NEAR_DUP_WINDOW_S,
  RING_CAPACITY,
  STORY_WINDOW_S,
  TM_BITS_BYTES,
} from './story-key.config';

/** One confirmed projection: the id, its text-matching sign bits and `enTextChars`. */
export interface StoryKeySubmission {
  id: string;
  tmBits: Uint8Array | null;
  textChars: number;
}

type Join = 'known' | 'copy' | 'near' | 'minted';

interface StoryRow {
  id: string;
  timeSec: number;
  /** Interned exclusion group (publisher or feed); 0 = unknown, never excluded. */
  group: number;
  bits: Uint8Array | null;
  /** Takes part in layer 2 (bar on, bits present, text at the gate). */
  nearOk: boolean;
  copyHashes: string[];
  /** story_key already stored on the row, if any. */
  dbKey: string | null;
}

interface LeanStoryDoc {
  _id: Types.ObjectId;
  story_key?: unknown;
  copy_keys?: string[];
  publicationSourceId?: Types.ObjectId;
  vector_sidecar_tm_packed?: unknown;
  title_en_internal_only?: string;
  description_en_internal_only?: string;
}

const WORDS = TM_BITS_BYTES / 4;
const KEY_BYTES = 12;
const HEX_KEY = /^[0-9a-f]{24}$/;
const YIELD_EVERY = 25;
const WRITE_CHUNK = 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const REBUILD_RETRY_MS = 5 * 60 * 1000;

const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** SWAR popcount of a 32-bit word. */
function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/**
 * The stored Buffer field as bytes. A `.lean()` read hands back a Node Buffer
 * or a bson `Binary` (bytes in `.buffer`, length in `.position`), the same split
 * `toBase64Sidecar` handles on the read path.
 */
export function tmBitsFrom(raw: unknown): Uint8Array | null {
  if (!raw || typeof raw !== 'object') return null;
  let bytes: Uint8Array | null = null;
  if (raw instanceof Uint8Array) {
    bytes = raw;
  } else {
    const bin = raw as { buffer?: unknown; position?: number };
    if (bin.buffer instanceof Uint8Array) {
      bytes = bin.buffer.subarray(0, bin.position ?? bin.buffer.length);
    }
  }
  return bytes && bytes.length === TM_BITS_BYTES ? bytes : null;
}

const hashCopyKey = (key: string) =>
  createHash('sha1').update(key).digest('base64').slice(0, 16);

@Injectable()
export class StoryKeyIndexService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(StoryKeyIndexService.name);
  private readonly jobLogger: JobLogger;

  private capacity = 0;
  // Bits are read as Uint32 words but written only through the Uint8Array view:
  // a Uint32Array over a pooled Buffer slice throws on an unaligned byteOffset.
  private bits = new Uint32Array(0);
  private bitsU8 = new Uint8Array(0);
  private readonly query = new Uint32Array(WORDS);
  private readonly queryU8 = new Uint8Array(this.query.buffer);
  private seqOf = new Uint32Array(0);
  private timeOf = new Uint32Array(0);
  private groupOf = new Uint32Array(0);
  private keyOf = Buffer.alloc(0);
  private seeds = new Uint32Array(0);
  private seedHead = 0;
  private seedCount = 0;
  private nextSeq = 1;
  private wraps = 0;
  private readonly copyMap = new Map<string, number>();
  private readonly idSlot = new Map<string, number>();
  private readonly groups = new Map<string, number>();
  private publisherBySource = new Map<string, string>();

  private ready = false;
  private lastRebuildAt = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private sweepTimer?: NodeJS.Timeout;
  private readonly calibrated: boolean;

  constructor(
    @InjectModel(NewsArticle.name)
    private readonly articleModel: Model<NewsArticleDocument>,
    @InjectModel(PublicationSource.name)
    private readonly publicationSourceModel: Model<PublicationSourceDocument>,
    config: ConfigService,
  ) {
    this.calibrated = isCalibratedEmbedding(config);
    this.jobLogger = new JobLogger({
      job: 'story-key-index',
      level: JobLogger.parseLevel(config.get<string>('LOG_LEVEL')),
    });
  }

  onApplicationBootstrap(): void {
    // Not awaited: boot must not wait for a 48h stream. Assignments queue
    // behind it on the chain, and projection never waits for either.
    void this.enqueue(() => this.rebuild()).catch(() => undefined);
    this.sweepTimer = setInterval(() => {
      void this.enqueue(() => this.sweep()).catch((err) =>
        this.jobLogger.warn('story_key_sweep_failed', {
          error: (err as Error).message,
        }),
      );
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  /** Fire-and-forget: assign and persist story keys for confirmed projections. */
  submit(entries: StoryKeySubmission[]): void {
    if (entries.length === 0) return;
    void this.enqueue(() => this.assignBatch(entries)).catch((err) =>
      this.jobLogger.warn('story_key_assign_failed', {
        articles: entries.length,
        error: (err as Error).message,
      }),
    );
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async assignBatch(entries: StoryKeySubmission[]): Promise<void> {
    if (!this.ready && Date.now() - this.lastRebuildAt >= REBUILD_RETRY_MS) {
      await this.rebuild().catch(() => undefined);
    }
    const docs = await this.articleModel
      .find(
        { _id: { $in: entries.map((e) => new Types.ObjectId(e.id)) } },
        { copy_keys: 1, publicationSourceId: 1, story_key: 1 },
      )
      .lean<LeanStoryDoc[]>();
    const byId = new Map(docs.map((d) => [d._id.toString(), d]));

    const counts = { copy: 0, near: 0, minted: 0, known: 0, fallback: 0 };
    const scanMs: number[] = [];
    const ops: AnyBulkWriteOperation<NewsArticleDocument>[] = [];
    for (let i = 0; i < entries.length; i++) {
      const doc = byId.get(entries[i].id);
      if (doc) {
        const row = this.toRow(doc, entries[i].tmBits, entries[i].textChars);
        // Index failure falls back to the article's own _id, never null.
        let key = row.dbKey ?? row.id;
        if (this.ready) {
          try {
            const t0 = performance.now();
            const out = this.assignRow(row);
            scanMs.push(performance.now() - t0);
            key = out.key;
            counts[out.join]++;
          } catch (err) {
            counts.fallback++;
            this.logger.warn(`story key assign fell back: ${String(err)}`);
          }
        } else {
          counts.fallback++;
        }
        if (!row.dbKey) ops.push(this.keyOp(row.id, key));
      }
      if ((i + 1) % YIELD_EVERY === 0) await yieldLoop();
    }
    await this.write(ops);

    scanMs.sort((a, b) => a - b);
    this.jobLogger.info('story_key_assign', {
      articles: entries.length,
      joinedCopy: counts.copy,
      joinedNear: counts.near,
      minted: counts.minted,
      known: counts.known,
      fallback: counts.fallback,
      scanMsP95: scanMs.length
        ? Number(
            scanMs[
              Math.min(scanMs.length - 1, Math.floor(scanMs.length * 0.95))
            ].toFixed(2),
          )
        : null,
      seeds: this.seedCount,
    });
  }

  /**
   * Reset, then stream the last 48h (`_id` range, ~500 B a row with the two
   * English text fields) in `_id` order: rows with a key are registered (their
   * own `_id` as key makes them a seed when they pass the near-copy gate),
   * rows with bits and no key are assigned and written with the same write-once
   * op. One pass is both rebuild and backfill.
   */
  private async rebuild(): Promise<void> {
    const started = Date.now();
    this.lastRebuildAt = started;
    this.ready = false;
    this.reset();
    try {
      await this.loadPublishers();
      const since = Types.ObjectId.createFromTime(
        Math.floor(started / 1000) - STORY_WINDOW_S,
      );
      const cursor = this.articleModel
        .find({
          _id: { $gte: since },
          vector_sidecar_tm_packed: { $exists: true },
        })
        .select(
          '_id story_key copy_keys publicationSourceId +vector_sidecar_tm_packed title_en_internal_only description_en_internal_only',
        )
        .sort({ _id: 1 })
        .lean<LeanStoryDoc[]>()
        .cursor({ batchSize: 5000 });

      let pending: AnyBulkWriteOperation<NewsArticleDocument>[] = [];
      let rows = 0;
      let backfilled = 0;
      for await (const doc of cursor as AsyncIterable<LeanStoryDoc>) {
        rows++;
        const row = this.toRow(
          doc,
          tmBitsFrom(doc.vector_sidecar_tm_packed),
          enTextChars(
            doc.title_en_internal_only,
            doc.description_en_internal_only,
          ),
        );
        const { key } = this.assignRow(row);
        if (!row.dbKey) {
          pending.push(this.keyOp(row.id, key));
          backfilled++;
          if (backfilled % YIELD_EVERY === 0) await yieldLoop();
        }
        if (pending.length >= WRITE_CHUNK) {
          await this.write(pending);
          pending = [];
        }
      }
      await this.write(pending);
      this.ready = true;

      const mem = process.memoryUsage();
      this.jobLogger.info('story_key_index_ready', {
        rows,
        seeds: this.seedCount,
        keys: this.copyMap.size,
        backfilled,
        ms: Date.now() - started,
        arrayBuffersMb: Math.round(mem.arrayBuffers / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
      });
    } catch (err) {
      // Not ready: assignments write each article's own _id until a retry
      // (next submit at least REBUILD_RETRY_MS later) succeeds.
      this.jobLogger.error('story_key_index_rebuild_failed', {
        error: (err as Error).message,
        ms: Date.now() - started,
      });
      throw err;
    }
  }

  private async sweep(): Promise<void> {
    const cutoff = Math.floor(Date.now() / 1000) - STORY_WINDOW_S;
    for (const [hash, seq] of this.copyMap) {
      if (!this.liveSince(seq, cutoff)) this.copyMap.delete(hash);
    }
    for (const [id, seq] of this.idSlot) {
      if (!this.liveSince(seq, cutoff)) this.idSlot.delete(id);
    }
    while (
      this.seedCount > 0 &&
      !this.liveSince(this.seeds[this.seedHead], cutoff)
    ) {
      this.popSeed();
    }
    await this.loadPublishers().catch((err) =>
      this.logger.warn(`publisher reload failed: ${String(err)}`),
    );
    this.jobLogger.info('story_key_index_sweep', {
      keys: this.copyMap.size,
      ids: this.idSlot.size,
      seeds: this.seedCount,
      wraps: this.wraps,
    });
  }

  /** Synchronous by contract: the scan and the insert never cross an await. */
  private assignRow(row: StoryRow): { key: string; join: Join } {
    const known = this.idSlot.get(row.id);
    if (known !== undefined && this.valid(known)) {
      return { key: this.keyAt(known), join: 'known' };
    }
    if (row.dbKey) {
      if (HEX_KEY.test(row.dbKey)) {
        this.insert(row, row.dbKey, row.dbKey === row.id && row.nearOk);
      }
      return { key: row.dbKey, join: 'known' };
    }

    // Oldest story wins. A story key is its seed's ObjectId (timestamp first),
    // so the lowest 24-char hex is the oldest story. Not the lowest seq:
    // insert() re-points a copy key to its newest carrier, so seq is not age.
    let copyKey: string | null = null;
    for (const hash of row.copyHashes) {
      const seq = this.copyMap.get(hash);
      if (seq === undefined || !this.within(seq, row.timeSec, STORY_WINDOW_S)) {
        continue;
      }
      const key = this.keyAt(seq);
      if (copyKey === null || key < copyKey) copyKey = key;
    }
    if (copyKey) {
      this.insert(row, copyKey, false);
      return { key: copyKey, join: 'copy' };
    }

    if (row.nearOk) {
      const seedSeq = this.findSeed(row);
      if (seedSeq) {
        const key = this.keyAt(seedSeq);
        this.insert(row, key, false);
        return { key, join: 'near' };
      }
    }

    this.insert(row, row.id, row.nearOk);
    return { key: row.id, join: 'minted' };
  }

  // shortcut: linear scan, ~7ms/550k seeds on M1; build MIH (choose bands from least-biased bits) if story_key_assign scanMsP95 > 50ms
  private findSeed(row: StoryRow): number {
    this.queryU8.set(row.bits as Uint8Array);
    const c = this.capacity;
    for (let i = 0; i < this.seedCount; i++) {
      const seq = this.seeds[(this.seedHead + i) % c];
      const slot = seq % c;
      if (this.seqOf[slot] !== seq) continue;
      const dt = this.timeOf[slot] - row.timeSec;
      if (dt > NEAR_DUP_WINDOW_S || dt < -NEAR_DUP_WINDOW_S) continue;
      if (row.group !== 0 && this.groupOf[slot] === row.group) continue;
      const base = slot * WORDS;
      let d = 0;
      for (let w = 0; w < WORDS; w++) {
        d += popcount32(this.bits[base + w] ^ this.query[w]);
        if (d > HAMMING_BAR) break;
      }
      if (d <= HAMMING_BAR) return seq;
    }
    return 0;
  }

  private insert(row: StoryRow, key: string, seed: boolean): void {
    const c = this.capacity;
    const seq = this.nextSeq++;
    const slot = seq % c;
    if (this.seqOf[slot] !== 0) {
      // The oldest slot is overwritten: it can only under-merge.
      if (this.wraps === 0) {
        this.jobLogger.warn('story_key_ring_wrapped', { capacity: c });
      }
      this.wraps++;
    }
    this.seqOf[slot] = seq;
    this.timeOf[slot] = row.timeSec;
    this.groupOf[slot] = row.group;
    this.keyOf.write(key, slot * KEY_BYTES, KEY_BYTES, 'hex');
    if (row.bits) {
      this.bitsU8.set(row.bits, slot * TM_BITS_BYTES);
    } else {
      this.bitsU8.fill(0, slot * TM_BITS_BYTES, (slot + 1) * TM_BITS_BYTES);
    }
    // Every assignment re-points its keys here, so a key lives as long as its
    // newest carrier.
    for (const hash of row.copyHashes) this.copyMap.set(hash, seq);
    this.idSlot.set(row.id, seq);

    if (seed) {
      while (this.seedCount > 0 && !this.valid(this.seeds[this.seedHead])) {
        this.popSeed();
      }
      if (this.seedCount === c) this.popSeed();
      this.seeds[(this.seedHead + this.seedCount) % c] = seq;
      this.seedCount++;
    }
  }

  private popSeed(): void {
    this.seedHead = (this.seedHead + 1) % this.capacity;
    this.seedCount--;
  }

  private valid(seq: number): boolean {
    return seq > 0 && this.seqOf[seq % this.capacity] === seq;
  }

  private within(seq: number, timeSec: number, windowS: number): boolean {
    return (
      this.valid(seq) &&
      Math.abs(this.timeOf[seq % this.capacity] - timeSec) <= windowS
    );
  }

  private liveSince(seq: number, cutoffSec: number): boolean {
    return this.valid(seq) && this.timeOf[seq % this.capacity] >= cutoffSec;
  }

  private keyAt(seq: number): string {
    const off = (seq % this.capacity) * KEY_BYTES;
    return this.keyOf.toString('hex', off, off + KEY_BYTES);
  }

  private reset(): void {
    const c = RING_CAPACITY;
    if (this.capacity === c) {
      // Reuse the backing stores: a second ~97 MB allocation would count
      // against news-async's non-heap headroom before the old one is freed.
      this.bits.fill(0);
      this.seqOf.fill(0);
      this.timeOf.fill(0);
      this.groupOf.fill(0);
      this.keyOf.fill(0);
      this.seeds.fill(0);
    } else {
      this.capacity = c;
      this.bits = new Uint32Array(c * WORDS);
      this.bitsU8 = new Uint8Array(this.bits.buffer);
      this.seqOf = new Uint32Array(c);
      this.timeOf = new Uint32Array(c);
      this.groupOf = new Uint32Array(c);
      this.keyOf = Buffer.alloc(c * KEY_BYTES);
      this.seeds = new Uint32Array(c);
    }
    this.seedHead = 0;
    this.seedCount = 0;
    this.nextSeq = 1;
    this.wraps = 0;
    this.copyMap.clear();
    this.idSlot.clear();
    this.groups.clear();
  }

  private async loadPublishers(): Promise<void> {
    if (NEAR_DUP_EXCLUSION !== 'publisher') return;
    const rows = await this.publicationSourceModel
      .find({}, { newsPublisherId: 1 })
      .lean<Array<{ _id: Types.ObjectId; newsPublisherId?: Types.ObjectId }>>();
    const map = new Map<string, string>();
    for (const r of rows) {
      if (r.newsPublisherId)
        map.set(r._id.toString(), String(r.newsPublisherId));
    }
    this.publisherBySource = map;
  }

  private groupIndex(sourceId: string | null): number {
    if (!sourceId) return 0;
    // A feed not yet in the map (added since the last reload) is its own group.
    const name =
      NEAR_DUP_EXCLUSION === 'publisher'
        ? (this.publisherBySource.get(sourceId) ?? `source:${sourceId}`)
        : sourceId;
    let idx = this.groups.get(name);
    if (idx === undefined) {
      idx = this.groups.size + 1;
      this.groups.set(name, idx);
    }
    return idx;
  }

  private toRow(
    doc: LeanStoryDoc,
    raw: Uint8Array | null,
    textChars: number,
  ): StoryRow {
    const id = doc._id.toString();
    const bits = raw && raw.length === TM_BITS_BYTES ? raw : null;
    return {
      id,
      timeSec: parseInt(id.slice(0, 8), 16),
      group: this.groupIndex(
        doc.publicationSourceId ? String(doc.publicationSourceId) : null,
      ),
      bits,
      nearOk:
        this.calibrated &&
        HAMMING_BAR > 0 &&
        bits !== null &&
        textChars >= MIN_TEXT_CHARS,
      copyHashes: (doc.copy_keys ?? []).map(hashCopyKey),
      dbKey: typeof doc.story_key === 'string' ? doc.story_key : null,
    };
  }

  /**
   * Write-once: the pipeline `$ifNull` keeps a key already stored, so a retry
   * or a second process never rewrites it. `$literal` because a pipeline `$set`
   * evaluates expressions.
   */
  private keyOp(
    id: string,
    key: string,
  ): AnyBulkWriteOperation<NewsArticleDocument> {
    return {
      updateOne: {
        filter: { _id: new Types.ObjectId(id) },
        update: [
          {
            $set: { story_key: { $ifNull: ['$story_key', { $literal: key }] } },
          },
        ],
      },
    } as AnyBulkWriteOperation<NewsArticleDocument>;
  }

  /** Never throws: a failed write leaves the rows null until the next boot backfill. */
  private async write(
    ops: AnyBulkWriteOperation<NewsArticleDocument>[],
  ): Promise<void> {
    if (ops.length === 0) return;
    try {
      await this.articleModel.bulkWrite(ops, { ordered: false });
    } catch (err) {
      this.jobLogger.warn('story_key_write_failed', {
        ops: ops.length,
        error: (err as Error).message,
      });
    }
  }
}
