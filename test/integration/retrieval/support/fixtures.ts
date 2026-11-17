import { Types, type Connection } from 'mongoose';
import { FakeEmbeddingProvider, topicEmbedText } from '@mera/news-core';

/**
 * Raw-collection fixtures for the retrieval tests. Inserted with the driver,
 * not the models, so `createdAt` is exactly what the test sets (the models'
 * timestamps would otherwise stamp it). Every date is relative to now.
 */

let counter = 0;
const next = () => ++counter;

export const hoursAgo = (hours: number): Date =>
  new Date(Date.now() - hours * 60 * 60 * 1000);

/**
 * The vector a `$vectorSearch` for `topicText` scores at exactly `score`
 * (Atlas cosine score, `(1 + cos) / 2`). The query side embeds
 * `topicEmbedText(topicText)` ("News about ..."), never the bare text, so a
 * fixture built from the bare text would not match.
 */
export function vectorWithScore(topicText: string, score: number): number[] {
  const u = FakeEmbeddingProvider.vectorFor(topicEmbedText(topicText));
  const cos = 2 * score - 1;
  if (cos >= 1) return u;
  // Gram-Schmidt: a unit vector orthogonal to u.
  const raw = FakeEmbeddingProvider.vectorFor(`orthogonal to ${topicText}`);
  const dot = raw.reduce((sum, x, i) => sum + x * u[i], 0);
  const w = raw.map((x, i) => x - dot * u[i]);
  const norm = Math.sqrt(w.reduce((sum, x) => sum + x * x, 0));
  const sin = Math.sqrt(1 - cos * cos);
  return u.map((x, i) => cos * x + (sin * w[i]) / norm);
}

export interface SeededSource {
  _id: Types.ObjectId;
  feed_url: string;
  country_code: string;
}

export async function seedPublisher(
  connection: Connection,
  overrides: Record<string, unknown> = {},
): Promise<Types.ObjectId> {
  const n = next();
  const _id = new Types.ObjectId();
  await connection.collection('news-publisher').insertOne({
    _id,
    name: `Example Publisher ${n}`,
    website_url: `https://example.test/publisher-${n}`,
    country_code: 'NLD',
    is_active: true,
    createdAt: hoursAgo(24 * 30),
    updatedAt: hoursAgo(24 * 30),
    ...overrides,
  });
  return _id;
}

export async function seedSource(
  connection: Connection,
  overrides: Record<string, unknown> = {},
): Promise<SeededSource> {
  const n = next();
  const doc = {
    _id: new Types.ObjectId(),
    publication_name: `Example Daily ${n}`,
    publication_url: `https://example.test/daily-${n}`,
    feed_url: `https://example.test/daily-${n}/feed.xml`,
    type: 'rss-feed',
    feed_language_code: 'en',
    country_code: 'NLD',
    category: 'general',
    is_active: true,
    createdAt: hoursAgo(24 * 30),
    updatedAt: hoursAgo(24 * 30),
    ...overrides,
  };
  await connection.collection('publication-source').insertOne(doc);
  return doc as SeededSource;
}

export interface SeedArticleOptions {
  source: SeededSource;
  /** Default: one hour ago. Also used as `pubDate`. */
  createdAt?: Date;
  /** The retrieval vector; omit for an article no vector search can find. */
  vector?: number[];
  /** Marks the URL insecure, which every serving path filters out. */
  insecure?: boolean;
  overrides?: Record<string, unknown>;
}

export async function seedArticle(
  connection: Connection,
  options: SeedArticleOptions,
): Promise<Types.ObjectId> {
  const n = next();
  const createdAt = options.createdAt ?? hoursAgo(1);
  const _id = new Types.ObjectId();
  await connection.collection('news-article').insertOne({
    _id,
    title: `Example headline ${n}`,
    title_en_internal_only: `Example headline ${n}`,
    description: `Example description ${n}`,
    description_en_internal_only: `Example description ${n}`,
    pubDate: createdAt,
    article_url: `https://example.test/articles/${n}`,
    source_uri: options.source.feed_url,
    publicationSourceId: options.source._id,
    type: 'rss-feed',
    language_code: 'en',
    createdAt,
    updatedAt: createdAt,
    ...(options.vector
      ? { embedding_article_data_retrieval: options.vector }
      : {}),
    ...(options.insecure ? { url_security_state: 'insecure' } : {}),
    ...options.overrides,
  });
  return _id;
}

/** An anonymous topic row, as the cold path would have upserted it. */
export async function seedTopic(
  connection: Connection,
  text: string,
  overrides: Record<string, unknown> = {},
): Promise<Types.ObjectId> {
  const _id = new Types.ObjectId();
  await connection.collection('user-topic').insertOne({
    _id,
    news_topic_text: text,
    news_topic_embed: FakeEmbeddingProvider.vectorFor(topicEmbedText(text)),
    is_canonical: false,
    createdAt: hoursAgo(2),
    updatedAt: hoursAgo(2),
    lastRequestedAt: hoursAgo(2),
    ...overrides,
  });
  return _id;
}

export async function seedTopicLink(
  connection: Connection,
  topicId: Types.ObjectId,
  articleId: Types.ObjectId,
  confidence: number,
): Promise<void> {
  await connection.collection('topic-article-link').insertOne({
    topicId,
    articleId,
    confidence,
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
  });
}

/** A complete cluster generation: one link per article, `clusterSize` equal to the link count. */
export async function seedCluster(
  connection: Connection,
  articleIds: Types.ObjectId[],
  overrides: Record<string, unknown> = {},
): Promise<Types.ObjectId> {
  const n = next();
  const _id = new Types.ObjectId();
  await connection.collection('news-cluster').insertOne({
    _id,
    clusterSize: articleIds.length,
    stableClusterId: `stable-${n}`,
    clusteringRunId: `run-${n}`,
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
    ...overrides,
  });
  if (articleIds.length > 0) {
    await connection.collection('cluster-article-link').insertMany(
      articleIds.map((articleId) => ({
        clusterId: _id,
        articleId,
        confidence: 0.9,
        clusteringRunId: `run-${n}`,
        createdAt: hoursAgo(1),
        updatedAt: hoursAgo(1),
      })),
    );
  }
  return _id;
}

/**
 * A fresh headline edition for `scopeKey` (alpha-3 or `GLOBAL`), ranked in
 * the order given. Built now, so it is inside the serve path's age limit.
 */
export async function seedHeadlineEdition(
  connection: Connection,
  scopeKey: string,
  articleIds: Types.ObjectId[],
): Promise<void> {
  const entries = articleIds.map((articleId, i) => ({
    articleId,
    clusterId: null,
    stableClusterId: null,
    clusterSize: 0,
    inScopeCount: 1,
    rank: i + 1,
  }));
  await connection.collection('headline-edition').insertOne({
    scopeKey,
    windowHours: 24,
    builtAt: new Date(),
    buildRunId: `fixture-${next()}`,
    entryCount: entries.length,
    entries,
    views: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}
