import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { AnyBulkWriteOperation } from 'mongodb';
import { Connection, Types } from 'mongoose';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '@mera/shared/embedding-provider/embedding-provider.port';
import { isCalibratedEmbedding } from '@mera/shared/embedding-provider/embedding-config';
import {
  CANONICAL_TOPIC_LEVELS,
  canonicalTopicText,
  categoryCentroid,
  categoryLabel,
  categoryLabelText,
  categoryLevel,
  categoryTreeNodes,
  classifyCanonical,
  type CanonicalIndexEntry,
} from '@mera/shared/enrichment/category-tree';

const EMBED_CHUNK = 128;
const WRITE_BATCH = 500;
const HOUR_MS = 3_600_000;

export interface SeedCanonicalTopicsOptions {
  execute?: boolean;
  allowDb?: string;
  backfillWindowHours?: number;
}

export interface SeedCanonicalTopicsResult {
  rows: number;
  inserted: number;
  scanned: number;
  linked: number;
  linksInserted: number;
}

/** Database name from the URI path (`mongodb+srv://u:p@h/name?x=y`), no credentials in errors. */
export function dbNameFromUri(uri: string | undefined): string {
  const m = /^mongodb(?:\+srv)?:\/\/[^/]*\/([^?]*)/.exec(uri ?? '');
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * Seeds the first-level canonical category rows in `user-topic` and links
 * recent articles to them in `topic-article-link`. Dry run unless `execute`.
 * Re-runnable: rows upsert on `news_topic_text`, links on `{topicId, articleId}`.
 * Links are written only for the embedding model the link thresholds were
 * tuned on, the same rule the ingest pipeline follows.
 */
@Injectable()
export class SeedCanonicalTopicsService {
  private readonly logger = new Logger(SeedCanonicalTopicsService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly config: ConfigService,
    @Inject(EMBEDDING_PROVIDER) private readonly embedder: EmbeddingProvider,
  ) {}

  /** The database that writes, its connection name and the URI path must all be the named one. */
  private assertDatabase(allowDb?: string): void {
    if (!allowDb) {
      throw new Error(
        'Refusing to run: pass --allow-db <name>, naming the database MONGODB_URI points at.',
      );
    }
    const names = {
      'db.databaseName': this.connection.db?.databaseName,
      'connection.name': this.connection.name,
      'URI path': dbNameFromUri(this.config.get<string>('MONGODB_URI')),
    };
    for (const [where, name] of Object.entries(names)) {
      if (name !== allowDb) {
        throw new Error(
          `Refusing to run: ${where} is '${String(name)}', expected '${allowDb}'. ` +
            `Point MONGODB_URI at the intended database, or pass --allow-db '${String(name)}'.`,
        );
      }
    }
  }

  private async embedAll(
    texts: string[],
    task: 'text-matching' | 'retrieval.query',
  ) {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_CHUNK) {
      out.push(
        ...(await this.embedder.embed(texts.slice(i, i + EMBED_CHUNK), task)),
      );
    }
    return out;
  }

  async run(
    options: SeedCanonicalTopicsOptions = {},
  ): Promise<SeedCanonicalTopicsResult> {
    this.assertDatabase(options.allowDb);
    const execute = options.execute ?? false;
    const windowHours = options.backfillWindowHours ?? 48;
    this.logger.log(
      `seed-canonical-topics db=${this.connection.db?.databaseName} ${execute ? 'EXECUTE' : 'DRY RUN, no writes'}`,
    );

    const nodes = categoryTreeNodes();
    const matchVectors = await this.embedAll(
      nodes.map(categoryLabelText),
      'text-matching',
    );
    const vecByNode = new Map(nodes.map((p, i) => [p, matchVectors[i]]));
    const vectorOf = (p: string) => vecByNode.get(p)!;

    const paths = nodes.filter((p) =>
      CANONICAL_TOPIC_LEVELS.includes(categoryLevel(p)),
    );
    const queryVectors = await this.embedAll(
      paths.map(categoryLabel),
      'retrieval.query',
    );
    const centroids = paths.map((p) => categoryCentroid(p, nodes, vectorOf));

    const topics = this.connection.collection('user-topic');
    let inserted = 0;
    if (execute) {
      const now = new Date();
      const res = await topics.bulkWrite(
        paths.map((path, i) => ({
          updateOne: {
            filter: { news_topic_text: canonicalTopicText(path) },
            update: {
              $set: {
                is_canonical: true,
                canonical_level: 1,
                canonical_path: path,
                canonical_parent_id: null,
                canonical_embed: centroids[i],
                news_topic_embed: queryVectors[i],
              },
              $setOnInsert: { createdAt: now, lastRequestedAt: now },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      inserted = res.upsertedCount;
    }
    this.logger.log(`rows: ${paths.length} L1 paths, ${inserted} inserted`);

    if (!isCalibratedEmbedding(this.config)) {
      this.logger.warn(
        'backfill skipped: article links are written only for the calibrated embedding model',
      );
      return {
        rows: paths.length,
        inserted,
        scanned: 0,
        linked: 0,
        linksInserted: 0,
      };
    }

    // Classify against what the database holds, so links point at real ids.
    let index: CanonicalIndexEntry[];
    if (execute) {
      const stored = await topics
        .find(
          { is_canonical: true, canonical_level: 1 },
          { projection: { canonical_embed: 1 } },
        )
        .toArray();
      index = stored.map((r) => ({
        topicId: String(r._id),
        vector: r.canonical_embed as number[],
      }));
    } else {
      index = paths.map((p, i) => ({ topicId: p, vector: centroids[i] }));
    }

    const backfill = await this.backfill(index, windowHours, execute);
    return { rows: paths.length, inserted, ...backfill };
  }

  private async backfill(
    index: CanonicalIndexEntry[],
    windowHours: number,
    execute: boolean,
  ) {
    const lo = Types.ObjectId.createFromTime(
      Math.floor((Date.now() - windowHours * HOUR_MS) / 1000),
    );
    const cursor = this.connection.collection('news-article').find(
      {
        _id: { $gte: lo },
        embedding_article_data_text_matching: { $type: 'array' },
      },
      { projection: { embedding_article_data_text_matching: 1 } },
    );
    const links = this.connection.collection('topic-article-link');
    let scanned = 0;
    let linked = 0;
    let linksInserted = 0;
    let batch: AnyBulkWriteOperation[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const res = await links.bulkWrite(batch, { ordered: false });
      linksInserted += res.upsertedCount;
      batch = [];
    };
    for await (const article of cursor) {
      scanned++;
      for (const link of classifyCanonical(
        article.embedding_article_data_text_matching as number[],
        index,
      )) {
        linked++;
        if (!execute) continue;
        batch.push({
          updateOne: {
            filter: {
              topicId: new Types.ObjectId(link.topicId),
              articleId: article._id,
            },
            update: {
              $setOnInsert: {
                confidence: link.confidence,
                canonical: true,
                createdAt: new Date(),
              },
            },
            upsert: true,
          },
        });
        if (batch.length >= WRITE_BATCH) await flush();
      }
    }
    await flush();
    this.logger.log(
      `backfill: scanned ${scanned}, classified ${linked}, inserted ${linksInserted}`,
    );
    return { scanned, linked, linksInserted };
  }
}
