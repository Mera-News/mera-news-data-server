import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { parse } from 'dotenv';

export const REPO_ROOT = resolve(__dirname, '../..');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);

// Keys that can point at a real service when they are exported in the shell.
const SENSITIVE_KEY =
  /^(MONGODB_URI|REDIS_URL|PERSISTENT_REDIS_URL|PROXY_URLS|GEMINI_\w+|JINA_\w+|OPENROUTER_\w+|GOOGLE_\w+|GCLOUD_\w+|\w+_API_KEY|\w+_TOKEN|\w+_SECRET)$/;

/** Every `.env*` file under `root` except `.env.example`. */
export function findEnvFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : findEnvFiles(path);
    }
    return entry.name.startsWith('.env') && entry.name !== '.env.example'
      ? [path]
      : [];
  });
}

/**
 * Sets to '' every key found in any `.env` file under `root`, and every
 * sensitive key already in the environment. dotenv and Nest's ConfigModule
 * never overwrite a key that is present, so a value from a `.env` file (which
 * may point at production) can no longer reach the code under test.
 */
export function blankEnv(root: string, env: NodeJS.ProcessEnv = process.env) {
  const keys = new Set<string>();
  for (const file of findEnvFiles(root)) {
    for (const key of Object.keys(parse(readFileSync(file)))) keys.add(key);
  }
  for (const key of Object.keys(env)) {
    if (SENSITIVE_KEY.test(key)) keys.add(key);
  }
  for (const key of keys) env[key] = '';
  return [...keys];
}

/** The harness configuration: fake providers, no network, no Redis. */
export const HARNESS_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'error',
  // A closed local port: an accidental Redis client fails fast and locally.
  REDIS_URL: 'redis://127.0.0.1:9',
  PERSISTENT_REDIS_URL: 'redis://127.0.0.1:9',
  MERA_SERVER_ASYNC_API_KEY: 'harness-api-key',
  TRANSLATION_PROVIDER: 'fake',
  EMBEDDING_PROVIDER: 'fake',
  ARTICLE_ENRICHMENT_PROVIDER: 'fake',
  GEMINI_TRANSPORT: 'developer',
  HTTP_UPGRADE_PROBE_ENABLED: 'false',
  PRE_PROCESS_ARTICLES_ENABLED: 'false',
  PREPROCESS_ON_INGEST_ENABLED: 'false',
  PROXY_FETCH_RETRIES: '0',
  PROXY_FETCH_TIMEOUT_MS: '5000',
};

/** The per-worker database on the replica set started by global-setup. */
export function harnessMongoUri(): string {
  const base = process.env.HARNESS_MONGO_URI;
  if (!base) throw new Error('HARNESS_MONGO_URI is unset: global-setup did not run');
  const url = new URL(base);
  url.pathname = `/mera-test-${process.env.JEST_WORKER_ID ?? '1'}`;
  return url.toString();
}

export function applyHarnessEnv(root: string = REPO_ROOT) {
  blankEnv(root);
  Object.assign(process.env, HARNESS_ENV, { MONGODB_URI: harnessMongoUri() });
}
