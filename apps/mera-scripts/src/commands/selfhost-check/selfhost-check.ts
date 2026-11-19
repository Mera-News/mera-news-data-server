import { createClient } from 'redis';
import mongoose, { type Connection } from 'mongoose';
import type { Db } from 'mongodb';
import {
  assertFakeAllowed,
  readBool,
  readChoice,
  readText,
  type ConfigReader,
} from '@mera/shared/config/env-choice';
import {
  embeddingDims,
  embeddingProvider,
  isCalibratedEmbedding,
  vectorMinScore,
} from '@mera/shared/embedding-provider/embedding-config';
import { checkEmbeddingMeta } from '@mera/shared/embedding-provider/embedding-meta';
import {
  feedFetchUserAgent,
  parseAllowHosts,
} from '@mera/shared/url/public-egress';
import { MongoSearchIndexAdmin } from '@mera/models/search-index/mongo-search-index-admin';
import type { SearchIndexAdmin } from '@mera/models/search-index/search-index-admin.port';
import {
  TEXT_INDEX_NAME,
  VECTOR_INDEX_NAME,
} from '@mera/models/search-index/retrieval-index';
import { SearchIndexService } from '@mera/models/search-index/search-index.service';

export type Level = 'ok' | 'info' | 'warning' | 'problem';
export interface Line {
  level: Level;
  text: string;
}

export interface CheckDeps {
  /** Answers when Redis does; throws when it does not. */
  ping?: (url: string) => Promise<void>;
  /** The search index admin for an open connection. */
  admin?: (connection: Connection) => SearchIndexAdmin;
  mongoTimeoutMs?: number;
}

const REDIS_TIMEOUT_MS = 2000;
const ok = (text: string): Line => ({ level: 'ok', text });
const info = (text: string): Line => ({ level: 'info', text });
const warning = (text: string): Line => ({ level: 'warning', text });
const problem = (text: string): Line => ({ level: 'problem', text });
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Every setting through its own reader; a reader that throws is one problem. */
export function checkSettings(config: ConfigReader): Line[] {
  const readers: Array<() => string> = [
    () => `EMBEDDING_PROVIDER is ${embeddingProvider(config)}`,
    () => `EMBEDDING_DIMS is ${embeddingDims(config)}`,
    () => `VECTOR_MIN_SCORE is ${vectorMinScore(config)}`,
    () =>
      `TRANSLATION_PROVIDER is ${readChoice(config, 'TRANSLATION_PROVIDER', ['gemini', 'routed', 'none', 'fake'], 'gemini')}`,
    () => `NEWS_API_OPEN is ${readBool(config, 'NEWS_API_OPEN', false)}`,
    () => `LOCAL_SCHEDULES is ${readBool(config, 'LOCAL_SCHEDULES', false)}`,
    () =>
      `SEARCH_INDEX_CREATE is ${readBool(config, 'SEARCH_INDEX_CREATE', true)}`,
    () =>
      `FEED_FETCH_ALLOW_HOSTS lists ${parseAllowHosts(config).length} hosts`,
    () => (feedFetchUserAgent(config), 'FEED_FETCH_USER_AGENT is valid'),
  ];
  return readers.map((read) => {
    try {
      return ok(read());
    } catch (error) {
      return problem(messageOf(error));
    }
  });
}

/** Presence only: a value is never printed. */
export function checkKeys(config: ConfigReader): Line[] {
  const lines: Line[] = [];
  const need = (key: string, why: string) =>
    lines.push(
      readText(config, key)
        ? ok(`${key} is set`)
        : problem(`${key} is not set. ${why}`),
    );
  // A reader that throws is already a problem line from the settings check.
  const safe = <T>(read: () => T, fallback: T): T => {
    try {
      return read();
    } catch {
      return fallback;
    }
  };

  const embedding = safe(() => embeddingProvider(config), undefined);
  if (embedding === 'jina') {
    need(
      'JINA_API_KEY',
      'Add your Jina key, or pick another EMBEDDING_PROVIDER.',
    );
  } else if (embedding === 'openai-compatible') {
    need('EMBEDDING_BASE_URL', 'Add the address of your embedding server.');
    need('EMBEDDING_MODEL', 'Add the model name your embedding server uses.');
  }
  const translation = safe(
    () =>
      readChoice(
        config,
        'TRANSLATION_PROVIDER',
        ['gemini', 'routed', 'none', 'fake'],
        'gemini',
      ),
    undefined,
  );
  const usesFake = embedding === 'fake' || translation === 'fake';
  if (usesFake && readText(config, 'NODE_ENV') === 'production') {
    try {
      assertFakeAllowed(config, 'EMBEDDING_PROVIDER');
    } catch {
      lines.push(
        problem(
          'ALLOW_FAKE_PROVIDERS is not true, and a fake provider is chosen under NODE_ENV=production. Set ALLOW_FAKE_PROVIDERS=true for a trial, or pick a real provider.',
        ),
      );
    }
  }
  const transport = readText(config, 'GEMINI_TRANSPORT') || 'developer';
  if (
    (translation === 'gemini' || translation === 'routed') &&
    transport === 'developer'
  ) {
    need(
      'GEMINI_API_KEY',
      'Add your Gemini key, or set TRANSLATION_PROVIDER=none.',
    );
  }
  need(
    'MERA_SERVER_ASYNC_API_KEY',
    'Set any long random value; the worker refuses every /invoke call without it.',
  );
  if (!safe(() => readBool(config, 'NEWS_API_OPEN', false), false)) {
    need(
      'MERA_NEWS_API_KEY',
      'Set any long random value, or set NEWS_API_OPEN=true to serve without a key.',
    );
  }
  need('REDIS_URL', 'Add the address of your Redis.');
  need('MONGODB_URI', 'Add the connection string of your MongoDB.');
  return lines;
}

/** The host part of an address, with any user, password and query removed. */
const hostOf = (authority: string) =>
  authority.slice(authority.lastIndexOf('@') + 1);

/**
 * Opens a connection with a short timeout. Returns the lines and, when it
 * answered, the connection: the caller closes it.
 */
export async function checkMongo(
  uri: string,
  timeoutMs: number,
): Promise<{ lines: Line[]; connection?: Connection }> {
  if (!uri) return { lines: [] };
  const parts = /^mongodb(?:\+srv)?:\/\/([^/?#]*)(?:\/([^?#]*))?/.exec(uri);
  if (!parts) {
    return {
      lines: [
        problem(
          'MONGODB_URI is not a MongoDB connection string. It starts with mongodb:// or mongodb+srv://.',
        ),
      ],
    };
  }
  const host = hostOf(parts[1]);
  if (!parts[2]) {
    return {
      lines: [
        problem(
          'MONGODB_URI names no database: add the database name to MONGODB_URI, after the host.',
        ),
      ],
    };
  }
  try {
    const connection = await mongoose
      .createConnection(uri, {
        serverSelectionTimeoutMS: timeoutMs,
        connectTimeoutMS: timeoutMs,
      })
      .asPromise();
    return {
      lines: [ok(`MongoDB answered at ${host}`)],
      connection,
    };
  } catch {
    return {
      lines: [
        problem(
          `MongoDB is unreachable at ${host}. Check MONGODB_URI, that the cluster is running, and that this machine's address is allowed to connect.`,
        ),
      ],
    };
  }
}

/** Reads both search indexes through the server's own reader. Creates nothing. */
export async function checkIndexes(
  admin: SearchIndexAdmin,
  config: ConfigReader,
): Promise<Line[]> {
  let report;
  let creationOn: boolean;
  try {
    // The server's own reader: `report()` only lists, it never creates.
    report = await new SearchIndexService(
      admin,
      { create: false },
      config,
    ).report();
    creationOn = readBool(config, 'SEARCH_INDEX_CREATE', true);
  } catch {
    // A setting that cannot be read is already a problem line.
    return [];
  }
  const named: Array<[string, { state: string; detail: string }]> = [
    [VECTOR_INDEX_NAME, report.vectorIndex],
    [TEXT_INDEX_NAME, report.textIndex],
  ];
  return named.map(([name, { state, detail }]) => {
    const text = `search index "${name}" is ${state}. ${detail}`;
    if (state === 'ready') return ok(`search index "${name}" is ready`);
    if (state === 'missing' && creationOn) {
      return info(
        `search index "${name}" does not exist yet. The worker creates it at its first start.`,
      );
    }
    return state === 'building' || state === 'unreadable'
      ? warning(text)
      : problem(text);
  });
}

export async function checkMeta(db: Db, config: ConfigReader): Promise<Line[]> {
  const lines: Line[] = [];
  try {
    await checkEmbeddingMeta(db, config, { write: false });
    lines.push(
      ok('the embedding model matches the one this database was built with'),
    );
  } catch (error) {
    return [problem(messageOf(error))];
  }
  try {
    lines.push(
      isCalibratedEmbedding(config)
        ? info(
            'the embedding setup is calibrated: answers carry a relevance score and near copies are grouped',
          )
        : info(
            'the embedding setup is not calibrated: answers carry no relevance score and near copies are not grouped. Pick VECTOR_MIN_SCORE with `npm run topic-scores`.',
          ),
    );
  } catch {
    // An unreadable setting is already a problem line.
  }
  return lines;
}

async function pingRedis(url: string): Promise<void> {
  const client = createClient({
    url,
    socket: {
      connectTimeout: REDIS_TIMEOUT_MS,
      socketTimeout: REDIS_TIMEOUT_MS,
      reconnectStrategy: false,
    },
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.ping();
  } finally {
    client.destroy();
  }
}

export async function checkRedis(
  url: string,
  ping: (url: string) => Promise<void>,
): Promise<Line[]> {
  if (!url) return [];
  let host: string;
  try {
    const parsed = new URL(url);
    host = `${parsed.hostname}:${parsed.port || '6379'}`;
  } catch {
    return [
      problem(
        'REDIS_URL is not a Redis address. It looks like redis://host:6379.',
      ),
    ];
  }
  try {
    await ping(url);
    return [ok(`Redis answered at ${host}`)];
  } catch {
    return [
      problem(
        `Redis is unreachable at ${host}. Check REDIS_URL and that Redis is running.`,
      ),
    ];
  }
}

export async function runChecks(
  config: ConfigReader,
  deps: CheckDeps = {},
): Promise<Line[]> {
  const lines = [...checkSettings(config), ...checkKeys(config)];
  const mongo = await checkMongo(
    readText(config, 'MONGODB_URI'),
    deps.mongoTimeoutMs ?? 5000,
  );
  lines.push(...mongo.lines);
  try {
    if (mongo.connection) {
      const admin = deps.admin
        ? deps.admin(mongo.connection)
        : new MongoSearchIndexAdmin(mongo.connection);
      lines.push(...(await checkIndexes(admin, config)));
      lines.push(...(await checkMeta(mongo.connection.db!, config)));
    }
  } finally {
    await mongo.connection?.close();
  }
  lines.push(
    ...(await checkRedis(
      readText(config, 'REDIS_URL'),
      deps.ping ?? pingRedis,
    )),
  );
  // A bad setting is met again by the checks that read it: say it once.
  return lines.filter(
    (line, i) => lines.findIndex((l) => l.text === line.text) === i,
  );
}

export const hasProblems = (lines: Line[]) =>
  lines.some((line) => line.level === 'problem');

/** One line each, then the verdict. */
export function formatLines(lines: Line[]): string[] {
  const count = lines.filter((line) => line.level === 'problem').length;
  return [
    ...lines.map((line) => `${line.level.padEnd(7)} ${line.text}`),
    count === 0
      ? 'all good'
      : `${count} ${count === 1 ? 'problem' : 'problems'}`,
  ];
}
