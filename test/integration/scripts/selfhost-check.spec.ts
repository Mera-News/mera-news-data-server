import { createServer, type AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { MongoClient } from 'mongodb';
import {
  runChecks,
  formatLines,
  hasProblems,
  type CheckDeps,
  type Line,
} from '../../../apps/mera-scripts/src/commands/selfhost-check/selfhost-check';
import { SelfhostCheckCommand } from '../../../apps/mera-scripts/src/commands/selfhost-check/selfhost-check.command';
import { SelfhostCheckModule } from '../../../apps/mera-scripts/src/commands/selfhost-check/selfhost-check.module';
import { InMemorySearchIndexAdmin } from '../../harness/atlas-search-fake';

// An unset key is the empty string, as the harness reads it.
const validEnv = (): Record<string, string> => ({
  NODE_ENV: 'production',
  ALLOW_FAKE_PROVIDERS: 'true',
  EMBEDDING_PROVIDER: 'fake',
  TRANSLATION_PROVIDER: 'fake',
  MERA_SERVER_ASYNC_API_KEY: 'async-key',
  MERA_NEWS_API_KEY: 'news-key',
  REDIS_URL: 'redis://127.0.0.1:6379',
  MONGODB_URI: process.env.MONGODB_URI!,
});

const reader = (env: Record<string, string>) => ({
  get: <T>(key: string) => env[key] as T | undefined,
});

const answersPong: CheckDeps['ping'] = () => Promise.resolve();
const readyIndexes =
  (dims = 768): CheckDeps['admin'] =>
  () =>
    InMemorySearchIndexAdmin.withReadyIndexes(dims);

const check = (env: Record<string, string>, deps: CheckDeps = {}) =>
  runChecks(reader({ ...validEnv(), ...env }), {
    ping: answersPong,
    admin: readyIndexes(),
    mongoTimeoutMs: 1500,
    ...deps,
  });
const problems = (lines: Line[]) => lines.filter((l) => l.level === 'problem');
const about = (lines: Line[], word: string) =>
  lines.filter((l) => l.text.includes(word));

describe('selfhost:check', () => {
  let client: MongoClient;
  const meta = () => client.db().collection<{ _id: string }>('deployment-meta');

  beforeAll(async () => {
    client = await MongoClient.connect(process.env.MONGODB_URI!);
  });
  afterAll(async () => {
    await client.close();
  });

  it('reports nothing wrong for a complete environment', async () => {
    const lines = await check({});

    expect(problems(lines)).toEqual([]);
    expect(hasProblems(lines)).toBe(false);
    expect(formatLines(lines).at(-1)).toBe('all good');
  });

  it('names an unreachable Redis by host and port', async () => {
    const lines = await check(
      { REDIS_URL: 'redis://:redis-pass@127.0.0.1:9' },
      { ping: undefined },
    );

    const found = problems(lines);
    expect(found).toHaveLength(1);
    expect(found[0].text).toContain('127.0.0.1:9');
    expect(found[0].text).not.toContain('redis-pass');
    expect(hasProblems(lines)).toBe(true);
    expect(formatLines(lines).at(-1)).toBe('1 problem');
  });

  // A server that accepts the connection and never answers: only the client's
  // own timeout can end the ping.
  it('reports a Redis that accepts the connection but never answers', async () => {
    const silent = createServer(() => undefined);
    await new Promise<void>((ok) => silent.listen(0, '127.0.0.1', ok));
    const { port } = silent.address() as AddressInfo;
    try {
      const started = Date.now();
      const lines = await check(
        { REDIS_URL: `redis://127.0.0.1:${port}` },
        { ping: undefined },
      );

      expect(problems(lines).map((l) => l.text)).toEqual([
        expect.stringContaining(`Redis is unreachable at 127.0.0.1:${port}`),
      ]);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      silent.close();
    }
  });

  it('gives each unreadable setting one problem with its own message', async () => {
    const lines = await check({
      EMBEDDING_PROVIDER: 'openai',
      FEED_FETCH_ALLOW_HOSTS: '*.lan',
    });

    const found = problems(lines);
    expect(found).toHaveLength(2);
    expect(about(found, 'EMBEDDING_PROVIDER')[0].text).toContain(
      'is not one of: jina, openai-compatible, fake',
    );
    expect(about(found, 'FEED_FETCH_ALLOW_HOSTS')[0].text).toContain(
      'must be a host or host:port',
    );
  });

  it('asks for the keys the chosen settings need', async () => {
    const jina = await check({
      EMBEDDING_PROVIDER: 'jina',
      JINA_API_KEY: '',
    });
    expect(about(problems(jina), 'JINA_API_KEY')).toHaveLength(1);

    const compatible = await check({ EMBEDDING_PROVIDER: 'openai-compatible' });
    expect(about(problems(compatible), 'EMBEDDING_BASE_URL')).toHaveLength(1);
    expect(about(problems(compatible), 'EMBEDDING_MODEL')).toHaveLength(1);

    const gemini = await check({ TRANSLATION_PROVIDER: 'gemini' });
    expect(about(problems(gemini), 'GEMINI_API_KEY')).toHaveLength(1);
    const vertex = await check({
      TRANSLATION_PROVIDER: 'gemini',
      GEMINI_TRANSPORT: 'vertex',
    });
    expect(about(vertex, 'GEMINI_API_KEY')).toEqual([]);

    const fake = await check({ ALLOW_FAKE_PROVIDERS: '' });
    expect(about(problems(fake), 'ALLOW_FAKE_PROVIDERS')).not.toEqual([]);

    const noRedis = await check({ REDIS_URL: '', MONGODB_URI: '' });
    expect(about(problems(noRedis), 'REDIS_URL')).toHaveLength(1);
    expect(about(problems(noRedis), 'MONGODB_URI')).toHaveLength(1);
    const noAsync = await check({ MERA_SERVER_ASYNC_API_KEY: '' });
    expect(about(problems(noAsync), 'MERA_SERVER_ASYNC_API_KEY')).toHaveLength(
      1,
    );
  });

  it('needs the news API key unless the API is open', async () => {
    const closed = await check({ MERA_NEWS_API_KEY: '' });
    expect(about(problems(closed), 'MERA_NEWS_API_KEY')).toHaveLength(1);

    const open = await check({ MERA_NEWS_API_KEY: '', NEWS_API_OPEN: 'true' });
    expect(about(open, 'MERA_NEWS_API_KEY')).toEqual([]);
    expect(problems(open)).toEqual([]);
  });

  it('asks for a database name and reads no indexes without one', async () => {
    let listed = false;
    const lines = await check(
      { MONGODB_URI: 'mongodb://127.0.0.1:27017' },
      {
        admin: () => {
          listed = true;
          return InMemorySearchIndexAdmin.withReadyIndexes();
        },
      },
    );

    const found = problems(lines);
    expect(found).toHaveLength(1);
    expect(found[0].text).toContain('add the database name to MONGODB_URI');
    expect(listed).toBe(false);
  });

  it('reports an unreachable MongoDB as one line naming only its host', async () => {
    const started = Date.now();
    const lines = await check({
      MONGODB_URI: 'mongodb://127.0.0.1:9/x',
    });

    const found = problems(lines);
    expect(found).toHaveLength(1);
    expect(found[0].text).toContain('127.0.0.1:9');
    expect(Date.now() - started).toBeLessThan(10_000);
    // Nothing downstream of the connection runs.
    expect(about(lines, 'search index')).toEqual([]);
  });

  it('refuses a database built with another embedding model', async () => {
    try {
      await meta().insertOne({
        _id: 'embedding',
        provider: 'openai-compatible',
        model: 'some-other-model',
        dims: 768,
        createdAt: new Date(),
      } as never);

      const lines = await check({});

      const found = problems(lines);
      expect(found).toHaveLength(1);
      expect(found[0].text).toContain('some-other-model');
    } finally {
      await meta().deleteMany({});
    }
  });

  it('reports a vector index of the wrong size, and a missing index as information', async () => {
    const wrong = await check(
      { EMBEDDING_DIMS: '768' },
      { admin: readyIndexes(1024) },
    );
    const found = problems(wrong);
    expect(found).toHaveLength(1);
    expect(found[0].text).toContain('1024');
    expect(found[0].text).toContain('EMBEDDING_DIMS is 768');

    const missing = await check(
      {},
      { admin: () => new InMemorySearchIndexAdmin() },
    );
    expect(problems(missing)).toEqual([]);
    expect(
      missing.filter(
        (l) => l.level === 'info' && l.text.includes('creates it'),
      ),
    ).toHaveLength(2);

    const off = await check(
      { SEARCH_INDEX_CREATE: 'false' },
      { admin: () => new InMemorySearchIndexAdmin() },
    );
    expect(problems(off)).toHaveLength(2);
  });

  it('prints a building index as a warning that leaves the exit code alone', async () => {
    const lines = await check(
      {},
      {
        admin: () => {
          const admin = InMemorySearchIndexAdmin.withReadyIndexes();
          for (const name of admin.indexes.keys()) {
            admin.setStatus(name, 'BUILDING', false);
          }
          return admin;
        },
      },
    );

    expect(lines.filter((l) => l.level === 'warning')).toHaveLength(2);
    expect(hasProblems(lines)).toBe(false);
  });

  it('says whether the embedding setup is the calibrated one', async () => {
    const calibrated = await check({});
    expect(about(calibrated, 'calibrated')[0].text).toContain('is calibrated');

    const other = await check(
      { EMBEDDING_DIMS: '1024' },
      { admin: readyIndexes(1024) },
    );
    const note = about(other, 'calibrated')[0];
    expect(note.level).toBe('info');
    expect(note.text).toContain('npm run topic-scores');
  });

  it('never prints a key, a password or a token', async () => {
    const lines = await check(
      {
        EMBEDDING_PROVIDER: 'jina',
        JINA_API_KEY: 'marker-key-1',
        MONGODB_URI:
          'mongodb://user:marker-pass-2@127.0.0.1:9/x?token=marker-3',
        REDIS_URL: 'redis://user:marker-pass-4@127.0.0.1:9',
        MERA_NEWS_API_KEY: 'marker-key-5',
      },
      { ping: undefined },
    );

    const out = formatLines(lines).join('\n');
    for (const marker of ['marker-key-1', 'marker-pass-2', 'marker-3']) {
      expect(out).not.toContain(marker);
    }
    expect(out).not.toContain('marker-pass-4');
    expect(out).not.toContain('marker-key-5');
    expect(out).toContain('JINA_API_KEY');
    expect(problems(lines).length).toBeGreaterThan(0);
  });

  it('runs from its own module with no database connection of its own', async () => {
    const logged: string[] = [];
    const log = jest
      .spyOn(console, 'log')
      .mockImplementation((line: string) => {
        logged.push(line);
      });
    const moduleRef = await Test.createTestingModule({
      imports: [SelfhostCheckModule],
    }).compile();
    const app = await moduleRef.init();
    try {
      await app.get(SelfhostCheckCommand).run();

      expect(logged.some((l) => /^ok\s+MongoDB/.test(l))).toBe(true);
      expect(logged.at(-1)).toMatch(/problems?$/);
      expect(process.exitCode).toBe(1);
    } finally {
      log.mockRestore();
      process.exitCode = undefined;
      await app.close();
    }
  });
});
