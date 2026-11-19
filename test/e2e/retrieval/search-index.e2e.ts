import { ChildProcess, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import {
  NEWS_ARTICLE_COLLECTION,
  retrievalIndexDefinition,
  textIndexDefinition,
} from '../../../libs/mera-models/src/search-index/retrieval-index';

/**
 * The search indexes against a real search service (the atlas-local service
 * container): the async worker builds both at boot, `listSearchIndexes` reads
 * as the states the server derives from it, and a vector size that disagrees
 * with the index stops a news API from starting.
 */

const repo = resolve(__dirname, '../../..');
const runId = `${Date.now()}`;
const asyncPort = 3105;
const newsApiPort = 3106;
const vector = retrievalIndexDefinition(768);
const text = textIndexDefinition();

function databaseUri(): string {
  const url = new URL(process.env.MONGODB_URI as string);
  url.pathname = `/e2e-search-index-${runId}`;
  return url.toString();
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until<T>(
  what: string,
  check: () => Promise<T | undefined>,
  timeoutMs = 180_000,
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

interface ListedIndex {
  name: string;
  status?: string;
  queryable?: boolean;
  latestDefinition?: { fields?: unknown[] };
}

describe('search indexes end to end', () => {
  const uri = databaseUri();
  let mongo: MongoClient;
  let db: Db;
  let worker: ChildProcess | undefined;
  let workerLog = '';

  const listed = async () =>
    (await db
      .collection(NEWS_ARTICLE_COLLECTION)
      .listSearchIndexes()
      .toArray()) as ListedIndex[];

  beforeAll(async () => {
    mongo = await MongoClient.connect(uri);
    db = mongo.db();
  });

  afterAll(async () => {
    if (worker && worker.exitCode === null) {
      worker.kill('SIGTERM');
      await new Promise((done) => worker!.once('exit', done));
    }
    if (mongo) {
      await db.dropDatabase();
      await mongo.close();
    }
  });

  it('builds both indexes at worker boot, and the server reads them as ready', async () => {
    worker = spawn(
      process.execPath,
      [join(repo, 'dist/apps/mera-server-async/main.js')],
      {
        cwd: repo,
        env: {
          ...process.env,
          MONGODB_URI: uri,
          PORT: String(asyncPort),
          NODE_ENV: 'production',
          SEARCH_INDEX_CREATE: '',
        },
      },
    );
    worker.stdout?.on('data', (d) => (workerLog += d));
    worker.stderr?.on('data', (d) => (workerLog += d));

    const indexes = await until('both indexes to be queryable', async () => {
      const found = await listed();
      const ready = [vector.name, text.name].every(
        (name) => found.find((i) => i.name === name)?.queryable,
      );
      return ready ? found : undefined;
    }).catch((error: Error) => {
      throw new Error(`${error.message}\n${workerLog.slice(-3000)}`);
    });

    // Extra fields in what Atlas reports are fine; the expected ones must be there.
    const built = indexes.find((i) => i.name === vector.name);
    expect(built?.latestDefinition?.fields).toEqual(
      expect.arrayContaining(vector.definition.fields),
    );

    // The worker read `building` at boot; its answer turns `ready` once the
    // 30 second cache expires, which proves the reader against Atlas's shape.
    const health = await until('the worker to report both ready', async () => {
      const res = await fetch(`http://127.0.0.1:${asyncPort}/health/ready`);
      const body = (await res.json()) as {
        info?: Record<string, { state: string }>;
      };
      return body.info?.vectorIndex?.state === 'ready' &&
        body.info?.textIndex?.state === 'ready'
        ? body
        : undefined;
    });
    expect(health).toBeDefined();
  });

  it('stops a news API whose vector size differs from the index, naming both sizes', async () => {
    // The worker recorded the embedding meta document; take it away so the
    // size mismatch is the only thing that can stop this process.
    await db.collection('deployment-meta').deleteMany({});

    const app = spawn(
      process.execPath,
      [join(repo, 'dist/apps/mera-server-news-api/main.js')],
      {
        cwd: repo,
        env: {
          ...process.env,
          MONGODB_URI: uri,
          PORT: String(newsApiPort),
          NODE_ENV: 'production',
          LOG_LEVEL: 'warn',
          MERA_NEWS_API_KEY: 'e2e-index-key',
          EMBEDDING_PROVIDER: 'fake',
          ALLOW_FAKE_PROVIDERS: 'true',
          EMBEDDING_DIMS: '1024',
          CACHE_STORE: 'memory',
        },
      },
    );
    let output = '';
    app.stdout?.on('data', (d) => (output += d));
    app.stderr?.on('data', (d) => (output += d));
    const code = await Promise.race([
      new Promise<number | null>((done) => app.once('exit', done)),
      sleep(90_000).then(() => {
        app.kill('SIGKILL');
        throw new Error(`the news API kept running\n${output.slice(-3000)}`);
      }),
    ]);

    expect(code).not.toBe(0);
    expect(output).toContain(vector.name);
    expect(output).toContain('768');
    expect(output).toContain('1024');
  });
});
