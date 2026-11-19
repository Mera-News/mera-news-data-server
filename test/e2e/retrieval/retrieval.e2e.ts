import { ChildProcess, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import mongoose, { Schema, type Connection, type Types } from 'mongoose';
import { createClient } from 'redis';
import {
  NEWS_ARTICLE_COLLECTION,
  retrievalIndexDefinition,
} from '../../../libs/mera-models/src/search-index/retrieval-index';
import { installAtlasSearchFake } from '../../harness/atlas-search-fake';
import {
  hoursAgo,
  seedArticle,
  seedSource,
  vectorWithScore,
} from '../../integration/retrieval/support/fixtures';
import { FakeEmbeddingProvider } from '../../../libs/mera-news-core/src/embedding-provider/fake-embedding.provider';
import { topicEmbedText } from '../../../libs/mera-news-core/src/embedding-provider/topic-embed-text';

/**
 * Retrieval against a real search index (the atlas-local service container)
 * and real Redis, through the built news API. Covers what the in-memory fake
 * cannot: the index definition and its readiness, approximate search ranking,
 * the score floor on real scores, and the classify cache in Redis. Each run
 * uses its own database and cache prefix.
 */

const repo = resolve(__dirname, '../../..');
const runId = `${Date.now()}`;
const apiKey = 'e2e-retrieval-key';
const appPort = 3103;
const cachePrefix = `e2e-retrieval-${runId}`;
const vectorIndex = {
  collection: NEWS_ARTICLE_COLLECTION,
  ...retrievalIndexDefinition(768),
};
const indexes = [vectorIndex];

function databaseUri(): string {
  const url = new URL(process.env.MONGODB_URI as string);
  url.pathname = `/e2e-retrieval-${runId}`;
  return url.toString();
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until<T>(
  what: string,
  check: () => Promise<T | undefined>,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}: ${String(last)}`);
}

interface SearchIndexInfo {
  queryable?: boolean;
  latestDefinition?: { fields?: unknown[] };
}

interface ScoredRow {
  _id: Types.ObjectId;
  score: number;
}

interface PersonaResult {
  articleIdsForPersona: {
    topicResults: {
      articleIds: string[];
      matchMeta: { articleId: string; vectorScore: number | null }[];
    }[];
  };
}

describe('retrieval end to end', () => {
  const uri = databaseUri();
  let mongo: MongoClient;
  let db: Db;
  let connection: Connection;
  let redis: ReturnType<typeof createClient>;
  let app: ChildProcess;
  let appLog = '';

  /** Polls until a `$vectorSearch` sees every one of `ids` (the index syncs asynchronously). */
  async function waitForIndexed(ids: Types.ObjectId[], probe: number[]) {
    const wanted = new Set(ids.map(String));
    await until('the search index to see the seeded articles', async () => {
      const seen = await db
        .collection('news-article')
        .aggregate([
          {
            $vectorSearch: {
              index: vectorIndex.name,
              path: 'embedding_article_data_retrieval',
              queryVector: probe,
              numCandidates: 1000,
              limit: 1000,
            },
          },
          { $project: { _id: 1 } },
        ])
        .toArray();
      const found = new Set(seen.map((d) => String(d._id)));
      return [...wanted].every((id) => found.has(id)) ? true : undefined;
    });
  }

  async function searchIndex(
    collection: string,
    name: string,
  ): Promise<SearchIndexInfo | undefined> {
    const [found] = (await db
      .collection(collection)
      .listSearchIndexes(name)
      .toArray()) as SearchIndexInfo[];
    return found;
  }

  async function resolveTopic(text: string): Promise<PersonaResult> {
    const res = await fetch(`http://127.0.0.1:${appPort}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        query: `query($q: PersonaQueryInput!) {
          articleIdsForPersona(query: $q) {
            topicResults { articleIds matchMeta { articleId vectorScore } }
          }
        }`,
        variables: { q: { topics: [{ text }] } },
      }),
    });
    const body = (await res.json()) as {
      data?: PersonaResult;
      errors?: unknown;
    };
    if (body.errors || !body.data) {
      throw new Error(`GraphQL errors: ${JSON.stringify(body.errors)}`);
    }
    return body.data;
  }

  beforeAll(async () => {
    mongo = await MongoClient.connect(uri);
    db = mongo.db();
    connection = await mongoose.createConnection(uri).asPromise();
    redis = createClient({ url: process.env.REDIS_URL });
    await redis.connect();

    // E1's subject: create every index from the definition the fake reads.
    for (const index of indexes) {
      await db.createCollection(index.collection);
      await db.collection(index.collection).createSearchIndex({
        name: index.name,
        type: index.type,
        definition: index.definition,
      });
    }
    await until('the search indexes to be queryable', async () => {
      for (const index of indexes) {
        const found = await searchIndex(index.collection, index.name);
        if (!found?.queryable) return undefined;
      }
      return true;
    });

    app = spawn(
      process.execPath,
      [join(repo, 'dist/apps/mera-server-news-api/main.js')],
      {
        cwd: repo,
        env: {
          ...process.env,
          MONGODB_URI: uri,
          PORT: String(appPort),
          NODE_ENV: 'production',
          MERA_NEWS_API_KEY: apiKey,
          EMBEDDING_PROVIDER: 'fake',
          CACHE_STORE: 'redis',
          CACHE_KEY_PREFIX: cachePrefix,
        },
      },
    );
    app.stdout?.on('data', (d) => (appLog += d));
    app.stderr?.on('data', (d) => (appLog += d));
    await until('the news API to report healthy', async () => {
      const res = await fetch(`http://127.0.0.1:${appPort}/health`);
      return res.ok ? true : undefined;
    }).catch((error: Error) => {
      throw new Error(`${error.message}\n${appLog.slice(-3000)}`);
    });
  });

  afterAll(async () => {
    if (app && app.exitCode === null) {
      app.kill('SIGTERM');
      await new Promise((done) => app.once('exit', done));
    }
    if (redis?.isOpen) {
      const keys = await redis.keys(`${cachePrefix}*`);
      if (keys.length > 0) await redis.del(keys);
      await redis.quit();
    }
    await connection?.close();
    if (mongo) {
      await db.dropDatabase();
      await mongo.close();
    }
  });

  it('E1: builds the vector index from the shared definition, with createdAt as a filter field', async () => {
    const found = await searchIndex(vectorIndex.collection, vectorIndex.name);
    expect(found?.queryable).toBe(true);
    expect(found?.latestDefinition?.fields).toEqual(
      expect.arrayContaining(vectorIndex.definition.fields),
    );

    // The filter field is accepted, and an undeclared one is refused, as the fake refuses it.
    const probe = FakeEmbeddingProvider.vectorFor('E1 probe');
    const stage = (filter: object) => ({
      $vectorSearch: {
        index: vectorIndex.name,
        path: 'embedding_article_data_retrieval',
        queryVector: probe,
        numCandidates: 10,
        limit: 1,
        filter,
      },
    });
    await expect(
      db
        .collection('news-article')
        .aggregate([stage({ createdAt: { $gte: hoursAgo(24) } })])
        .toArray(),
    ).resolves.toBeDefined();
    await expect(
      db
        .collection('news-article')
        .aggregate([stage({ url_security_state: { $ne: 'insecure' } })])
        .toArray(),
    ).rejects.toThrow();
  });

  it('E2: ranks a cold topic by score, and the fake ranks the same corpus the same way', async () => {
    const topic = `E2 harbour tram line ${runId}`;
    const source = await seedSource(connection);
    const ranked = [0.95, 0.9, 0.85, 0.8];
    const ids = new Map<number, Types.ObjectId>();
    // Seeded out of order so insertion order cannot explain the result.
    for (const score of [0.85, 0.95, 0.6, 0.8, 0.5, 0.9]) {
      ids.set(
        score,
        await seedArticle(connection, {
          source,
          vector: vectorWithScore(topic, score),
        }),
      );
    }
    const query = FakeEmbeddingProvider.vectorFor(topicEmbedText(topic));
    await waitForIndexed([...ids.values()], query);

    const [result] = (await resolveTopic(topic)).articleIdsForPersona
      .topicResults;
    expect(result.articleIds).toEqual(ranked.map((s) => String(ids.get(s))));
    result.matchMeta.forEach((meta, i) =>
      expect(meta.vectorScore).toBeCloseTo(ranked[i], 3),
    );

    // Same pipeline shape as the cold path, through the fake and through the real index.
    const pipeline = () => [
      {
        $vectorSearch: {
          index: vectorIndex.name,
          path: 'embedding_article_data_retrieval',
          queryVector: query,
          numCandidates: 200,
          limit: 100,
          filter: { createdAt: { $gte: hoursAgo(24) } },
        },
      },
      { $addFields: { score: { $meta: 'vectorSearchScore' } } },
      { $project: { _id: 1, score: 1 } },
    ];
    const articles = connection.model(
      'E2eArticle',
      new Schema({}, { strict: false }),
      'news-article',
    );
    const fake = installAtlasSearchFake();
    let fromFake: ScoredRow[];
    try {
      fromFake = await articles.aggregate<ScoredRow>(pipeline()).exec();
    } finally {
      fake.uninstall();
    }
    const fromIndex = await articles.aggregate<ScoredRow>(pipeline()).exec();
    expect(fromFake.map((d) => String(d._id))).toEqual(
      fromIndex.map((d) => String(d._id)),
    );
    fromFake.forEach((d, i) =>
      expect(d.score).toBeCloseTo(fromIndex[i].score, 3),
    );
  });

  it('E3: drops articles under the score floor, outside the 24h window or with an insecure URL', async () => {
    const topic = `E3 river ferry timetable ${runId}`;
    const source = await seedSource(connection);
    const strong = await seedArticle(connection, {
      source,
      vector: vectorWithScore(topic, 0.95),
    });
    const atFloor = await seedArticle(connection, {
      source,
      vector: vectorWithScore(topic, 0.79),
    });
    const excluded = [
      await seedArticle(connection, {
        source,
        vector: vectorWithScore(topic, 0.77),
      }),
      await seedArticle(connection, {
        source,
        createdAt: hoursAgo(25),
        vector: vectorWithScore(topic, 1.0),
      }),
      await seedArticle(connection, {
        source,
        insecure: true,
        vector: vectorWithScore(topic, 1.0),
      }),
    ];
    const query = FakeEmbeddingProvider.vectorFor(topicEmbedText(topic));
    await waitForIndexed([strong, atFloor, ...excluded], query);

    const [result] = (await resolveTopic(topic)).articleIdsForPersona
      .topicResults;
    expect(result.articleIds).toEqual([String(strong), String(atFloor)]);
  });

  it('E4: caches the classify answer in Redis and serves a repeat from it', async () => {
    const topic = `E4 night bus routes ${runId}`;
    const source = await seedSource(connection);
    const seeded = [
      await seedArticle(connection, {
        source,
        vector: vectorWithScore(topic, 0.9),
      }),
      await seedArticle(connection, {
        source,
        vector: vectorWithScore(topic, 0.85),
      }),
    ];
    const query = FakeEmbeddingProvider.vectorFor(topicEmbedText(topic));
    await waitForIndexed(seeded, query);

    const first = (await resolveTopic(topic)).articleIdsForPersona
      .topicResults[0];
    expect(first.articleIds).toEqual(seeded.map(String));

    const keys = (await redis.keys(`${cachePrefix}*`)).filter((k) =>
      k.includes('aft:'),
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(await redis.pTTL(key)).toBeGreaterThan(0);

    // With the articles gone, only the cached answer can return their ids.
    await db.collection('news-article').deleteMany({ _id: { $in: seeded } });
    const second = (await resolveTopic(topic)).articleIdsForPersona
      .topicResults[0];
    expect(second.articleIds).toEqual(first.articleIds);
  });
});
