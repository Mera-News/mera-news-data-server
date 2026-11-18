import { ChildProcess, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import mongoose, { type Connection, type Types } from 'mongoose';
import indexes from '../../harness/atlas-search-fake.indexes.json';
import {
  seedArticle,
  seedSource,
} from '../../integration/retrieval/support/fixtures';
import { FakeEmbeddingProvider } from '../../../libs/mera-news-core/src/embedding-provider/fake-embedding.provider';

/**
 * News search through the built news API against a real search index (the
 * atlas-local service container). Only the vector index is created, so the
 * text leg fails and the answer must still come from the vector leg alone.
 */

const repo = resolve(__dirname, '../../..');
const runId = `${Date.now()}`;
const apiKey = 'e2e-search-key';
const appPort = 3104;
const [vectorIndex] = indexes;

function databaseUri(): string {
  const url = new URL(process.env.MONGODB_URI as string);
  url.pathname = `/e2e-search-${runId}`;
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

/** A unit vector whose cosine with `u` is `cos`, so its search score is (1 + cos) / 2. */
function vectorNear(u: number[], cos: number, other: string): number[] {
  const raw = FakeEmbeddingProvider.vectorFor(other);
  const dot = raw.reduce((sum, x, i) => sum + x * u[i], 0);
  const w = raw.map((x, i) => x - dot * u[i]);
  const norm = Math.sqrt(w.reduce((sum, x) => sum + x * x, 0));
  const sin = Math.sqrt(1 - cos * cos);
  return u.map((x, i) => cos * x + (sin * w[i]) / norm);
}

describe('news search end to end', () => {
  const uri = databaseUri();
  let mongo: MongoClient;
  let db: Db;
  let connection: Connection;
  let app: ChildProcess;
  let appLog = '';

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

  async function search(query: string) {
    const res = await fetch(`http://127.0.0.1:${appPort}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        query:
          'query($q: String!) { searchNews(query: $q) { _id title_en score } }',
        variables: { q: query },
      }),
    });
    return (await res.json()) as {
      data?: { searchNews: { _id: string }[] };
      errors?: unknown;
    };
  }

  beforeAll(async () => {
    mongo = await MongoClient.connect(uri);
    db = mongo.db();
    connection = await mongoose.createConnection(uri).asPromise();

    await db.createCollection(vectorIndex.collection);
    await db.collection(vectorIndex.collection).createSearchIndex({
      name: vectorIndex.name,
      type: vectorIndex.type,
      definition: vectorIndex.definition,
    });
    await until('the vector index to be queryable', async () => {
      const [found] = (await db
        .collection(vectorIndex.collection)
        .listSearchIndexes(vectorIndex.name)
        .toArray()) as { queryable?: boolean }[];
      return found?.queryable ? true : undefined;
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
          LOG_LEVEL: 'warn',
          MERA_NEWS_API_KEY: apiKey,
          EMBEDDING_PROVIDER: 'fake',
          ALLOW_FAKE_PROVIDERS: 'true',
          CACHE_STORE: 'memory',
          SEARCH_CACHE_SECRET: 'e2e-search-secret',
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
    await connection?.close();
    if (mongo) {
      await db.dropDatabase();
      await mongo.close();
    }
  });

  it('returns the matching article first, from the vector leg alone', async () => {
    const query = `harbour tram line ${runId}`;
    const u = FakeEmbeddingProvider.vectorFor(query);
    const source = await seedSource(connection);
    const near = await seedArticle(connection, {
      source,
      vector: vectorNear(u, 0.7, 'near neighbour'),
    });
    const match = await seedArticle(connection, { source, vector: u });
    const far = await seedArticle(connection, {
      source,
      vector: FakeEmbeddingProvider.vectorFor('unrelated text'),
    });
    await waitForIndexed([near, match, far], u);

    const body = await search(query);

    expect(body.errors).toBeUndefined();
    // The far article is under the score floor.
    expect(body.data!.searchNews.map((h) => h._id)).toEqual([
      String(match),
      String(near),
    ]);
    // The answer itself is the proof: no text index exists, the far article
    // sits under the vector floor, and the two hits come back in vector-score
    // order. Atlas answers a search on a missing text index with no rows, not
    // an error, so nothing is logged for the lexical leg to assert on.
  });
});
