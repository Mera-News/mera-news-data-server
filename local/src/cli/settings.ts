import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createFakeEmbedder } from '../embed/fake.ts';
import type { Embedder } from '../embed/embedder.ts';
import { EmbedError } from '../embed/embedder.ts';
import { createLocalEmbedder, ensureModel } from '../embed/local.ts';
import { licenceNotice } from '../embed/models.ts';
import { DEFAULT_MODEL, MODELS } from '../embed/models.ts';
import { createOpenAiCompatibleEmbedder } from '../embed/openai-compatible.ts';
import { parseAllowHosts, type AllowList } from '../ingest/shared.ts';
import { CliError } from './errors.ts';

/** Keys kept in settings.json. The contact is not here: it lives in the store, where ingest reads it. */
export const SETTING_KEYS = ['embedder', 'embedder.model', 'embedder.url', 'embedder.dims', 'embedder.key', 'feeds.allowHosts'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type Settings = Partial<Record<SettingKey, string>>;

export interface Home {
  dir: string;
  db: string;
  models: string;
  settingsFile: string;
}

export function resolveHome(flag: string | undefined, env: Record<string, string | undefined>): Home {
  const dir = flag || env.MERA_NEWS_LOCAL_HOME || join(homedir(), '.mera-news-local');
  mkdirSync(dir, { recursive: true });
  return { dir, db: join(dir, 'news.db'), models: join(dir, 'models'), settingsFile: join(dir, 'settings.json') };
}

export function readSettings(home: Home): Settings {
  if (!existsSync(home.settingsFile)) return {};
  try {
    return JSON.parse(readFileSync(home.settingsFile, 'utf8')) as Settings;
  } catch {
    throw new CliError('config_invalid', `The settings file ${home.settingsFile} is not readable JSON.`);
  }
}

export function validateSetting(key: SettingKey, value: string): void {
  const bad = (why: string) => new CliError('config_invalid', `${key} ${why}.`);
  if (key === 'embedder' && value !== 'local' && value !== 'openai-compatible') throw bad('must be local or openai-compatible');
  if (key === 'embedder.dims' && !/^[1-9]\d*$/.test(value)) throw bad('must be a whole number above zero');
  if (key === 'embedder.url' && !/^https?:\/\//.test(value)) throw bad('must start with http:// or https://');
  if (key === 'feeds.allowHosts') {
    try {
      parseAllowHosts({ get: <T>() => value as T });
    } catch (error) {
      throw bad((error as Error).message.replace(/^FEED_FETCH_ALLOW_HOSTS /, 'is invalid: '));
    }
  }
}

export function writeSettings(home: Home, settings: Settings): void {
  writeFileSync(home.settingsFile, JSON.stringify(settings, null, 2), { mode: 0o600 });
  chmodSync(home.settingsFile, 0o600);
}

export function allowHostsOf(settings: Settings): AllowList {
  return parseAllowHosts({ get: <T>() => settings['feeds.allowHosts'] as T });
}

export interface EmbedderRequest {
  home: Home;
  settings: Settings;
  env: Record<string, string | undefined>;
  /** Overrides the configured model (`--model`). */
  model?: string;
  /** Fetch the model first when it is missing; otherwise a missing model is a refusal. */
  download?: boolean;
  onProgress?: (event: Record<string, unknown>) => void;
}

const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;

export const modelPresent = (home: Home, model: string): boolean => !!MODELS[model] && existsSync(join(home.models, MODELS[model].hubId));

/** The test embedder is honoured only with its second switch, so a stray variable never changes real data. */
function fakeEmbedder(env: Record<string, string | undefined>): Embedder | null {
  const wanted = env.MERA_NEWS_LOCAL_TEST_EMBEDDER;
  if (!wanted) return null;
  const dims = /^fake:([1-9]\d*)$/.exec(wanted)?.[1];
  if (env.MERA_NEWS_LOCAL_ALLOW_FAKE !== '1' || !dims) {
    throw new CliError('test_embedder_refused', 'MERA_NEWS_LOCAL_TEST_EMBEDDER is for tests and needs MERA_NEWS_LOCAL_ALLOW_FAKE=1 and the form fake:<dims>.');
  }
  return createFakeEmbedder(Number(dims));
}

export async function buildEmbedder(r: EmbedderRequest): Promise<Embedder> {
  const fake = fakeEmbedder(r.env);
  if (fake) return fake;
  const kind = r.settings.embedder ?? 'local';
  const model = r.model ?? r.settings['embedder.model'] ?? DEFAULT_MODEL;
  if (kind === 'openai-compatible') {
    const baseUrl = r.settings['embedder.url'];
    const dims = Number(r.settings['embedder.dims']);
    if (!baseUrl || !dims) throw new CliError('embedder_incomplete', 'The embedder is openai-compatible, so it needs a url and the number of dimensions.');
    return createOpenAiCompatibleEmbedder({ baseUrl, model, dims, apiKey: r.settings['embedder.key'] });
  }
  if (!MODELS[model]) throw new EmbedError('model_unknown', `The model ${model} is not one of ${Object.keys(MODELS).join(', ')}.`, '');
  if (!modelPresent(r.home, model)) {
    if (!r.download) throw new CliError('model_missing', `The model ${model} is not downloaded yet.`, { model });
    await downloadModel(r, model);
  }
  return createLocalEmbedder({ model, cacheDir: r.home.models });
}

export async function downloadModel(r: EmbedderRequest, model: string): Promise<void> {
  mkdirSync(r.home.models, { recursive: true });
  await ensureModel({
    model,
    cacheDir: r.home.models,
    onProgress: (p) => r.onProgress?.({ event: 'model_download', done_mb: mb(p.doneBytes), total_mb: mb(p.totalBytes) }),
  });
  const notice = licenceNotice(model);
  if (notice) r.onProgress?.({ event: 'licence_notice', model, message: notice });
}
