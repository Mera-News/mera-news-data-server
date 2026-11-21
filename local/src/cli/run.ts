import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_MODEL, licenceNotice } from '../embed/models.ts';
import { CONTACT_KEY, requireContact, runIngest, type IngestEvent } from '../ingest/ingest.ts';
import { acquireWriteLock, writeLockHolder } from '../ingest/lock.ts';
import { Store } from '../store/store.ts';
import { CliError, ERRORS, refusalOf } from './errors.ts';
import { loadSearch, loadServe, type SearchFn, type ServeFn } from './seams.ts';
import {
  SETTING_KEYS,
  allowHostsOf,
  buildEmbedder,
  downloadModel,
  readSettings,
  resolveHome,
  validateSetting,
  writeSettings,
  type EmbedderRequest,
  type Home,
  type SettingKey,
  type Settings,
} from './settings.ts';

const CMD = 'mera-news-local';

export interface Io {
  out(text: string): void;
  err(text: string): void;
  /** True when stdout is a terminal: short text instead of JSON. */
  tty: boolean;
}

export interface Deps {
  env: Record<string, string | undefined>;
  search?: SearchFn;
  serve?: ServeFn;
}

interface Result {
  data: Record<string, unknown>;
  text: string;
}

const OPTIONS = {
  home: { type: 'string' },
  json: { type: 'boolean' },
  model: { type: 'string' },
  name: { type: 'string' },
  country: { type: 'string' },
  language: { type: 'string' },
  file: { type: 'string' },
  only: { type: 'string', multiple: true },
  failed: { type: 'boolean' },
  feed: { type: 'string', multiple: true },
  limit: { type: 'string' },
  port: { type: 'string' },
  every: { type: 'string' },
  'older-than': { type: 'string' },
} as const;

const HELP = [
  'config set <key> <value> | config show',
  'model download [--model <id>]',
  'feeds add <url> | feeds load --only <selector> [--limit N] | feeds list [--failed]',
  'ingest [--feed <url>]',
  'search "<text>" [--limit N]',
  'status | prune --older-than <days> | reembed --model <id>',
  'serve [--port N] [--every <minutes>]',
  'Add --json for JSON and --home <dir> to use another folder.',
].join('\n');

const usage = (message: string) => new CliError('usage', message);

function whole(name: string, value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw usage(`--${name} must be a whole number above zero.`);
  return Number(value);
}

export async function run(argv: string[], io: Io, deps: Deps): Promise<number> {
  let secrets: string[] = [];
  const scrub = (text: string) => secrets.reduce((t, s) => t.split(s).join('***'), text);
  const wantJson = argv.includes('--json') || !io.tty;
  try {
    const { values, positionals } = (() => {
      try {
        return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
      } catch (error) {
        throw usage(`${(error as Error).message}. Run ${CMD} help to see the commands.`);
      }
    })();
    const home = resolveHome(values.home, deps.env);
    const settings = readSettings(home);
    secrets = settings['embedder.key'] ? [settings['embedder.key']] : [];
    const ctx: Ctx = { values, positionals, home, settings, deps, io, progress: (e) => io.err(`${scrub(JSON.stringify(e))}\n`) };
    const result = await command(ctx);
    io.out(scrub(wantJson ? JSON.stringify({ ok: true, ...result.data }) : result.text) + '\n');
    return 0;
  } catch (error) {
    const r = refusalOf(error);
    io.out(
      scrub(wantJson ? JSON.stringify({ ok: false, code: r.code, message: r.message, fix: r.fix, ...r.extra }) : `${r.message}${r.fix ? `\nFix: ${r.fix}` : ''}`) + '\n',
    );
    return r.exit;
  }
}

interface Ctx {
  values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];
  positionals: string[];
  home: Home;
  settings: Settings;
  deps: Deps;
  io: Io;
  progress: (event: Record<string, unknown>) => void;
}

async function command(ctx: Ctx): Promise<Result> {
  const [name, sub, ...rest] = ctx.positionals;
  switch (name) {
    case 'help':
    case undefined:
      return { data: { commands: HELP.split('\n') }, text: HELP };
    case 'config':
      if (sub === 'set') return configSet(ctx, rest);
      if (sub === 'show') return configShow(ctx);
      throw usage('Use config set <key> <value> or config show.');
    case 'model':
      if (sub === 'download') return modelDownload(ctx);
      throw usage('Use model download [--model <id>].');
    case 'feeds':
      if (sub === 'add') return feedsAdd(ctx, rest);
      if (sub === 'load') return feedsLoad(ctx);
      if (sub === 'list') return withStore(ctx, (store) => feedsList(ctx, store));
      throw usage('Use feeds add, feeds load or feeds list.');
    case 'ingest':
      return withStore(ctx, (store) => ingest(ctx, store));
    case 'search':
      return withStore(ctx, (store) => search(ctx, store, [sub, ...rest].filter(Boolean).join(' ')));
    case 'status':
      return withStore(ctx, (store) => status(ctx, store));
    case 'prune':
      return withStore(ctx, (store) => prune(ctx, store));
    case 'reembed':
      return withStore(ctx, (store) => reembed(ctx, store));
    case 'serve':
      return withStore(ctx, (store) => serve(ctx, store));
    default:
      throw usage(`${name} is not a command.`);
  }
}

async function withStore<T>(ctx: Ctx, fn: (store: Store) => Promise<T> | T): Promise<T> {
  const store = new Store(ctx.home.db);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

const embedderRequest = (ctx: Ctx, extra: Partial<EmbedderRequest> = {}): EmbedderRequest => ({
  home: ctx.home,
  settings: ctx.settings,
  env: ctx.deps.env,
  onProgress: ctx.progress,
  ...extra,
});

// ---- config

async function configSet(ctx: Ctx, args: string[]): Promise<Result> {
  const [key, value] = args;
  if (!key || value === undefined || args.length > 2) throw usage('Use config set <key> <value>.');
  if (key === 'contact') {
    if (!value.trim()) throw new CliError('config_invalid', 'The contact is empty. Give an email address or a website.');
    await withStore(ctx, (store) => store.setMeta(CONTACT_KEY, value.trim()));
  } else if ((SETTING_KEYS as readonly string[]).includes(key)) {
    validateSetting(key as SettingKey, value);
    writeSettings(ctx.home, { ...ctx.settings, [key]: value });
  } else {
    throw new CliError('config_invalid', `${key} is not a setting. The settings are contact, ${SETTING_KEYS.join(', ')}.`);
  }
  // The embedding key is never echoed, not even to the person who just typed it.
  const shown = key === 'embedder.key' ? 'set' : value;
  return { data: { key, value: shown }, text: `${key} is ${shown}.` };
}

async function configShow(ctx: Ctx): Promise<Result> {
  const contact = await withStore(ctx, (store) => store.getMeta(CONTACT_KEY));
  const s = ctx.settings;
  const shown = {
    home: ctx.home.dir,
    contact: contact ?? null,
    embedder: s.embedder ?? 'local',
    'embedder.model': s['embedder.model'] ?? DEFAULT_MODEL,
    'embedder.url': s['embedder.url'] ?? null,
    'embedder.dims': s['embedder.dims'] ? Number(s['embedder.dims']) : null,
    'embedder.key': s['embedder.key'] ? 'set' : 'unset',
    'feeds.allowHosts': s['feeds.allowHosts'] ?? null,
  };
  return { data: shown, text: Object.entries(shown).map(([k, v]) => `${k}: ${v ?? 'unset'}`).join('\n') };
}

// ---- model

async function modelDownload(ctx: Ctx): Promise<Result> {
  const model = ctx.values.model ?? ctx.settings['embedder.model'] ?? DEFAULT_MODEL;
  if (!ctx.deps.env.MERA_NEWS_LOCAL_TEST_EMBEDDER) await downloadModel(embedderRequest(ctx), model);
  const notice = licenceNotice(model);
  return { data: notice ? { model, notice } : { model }, text: notice ? `The model ${model} is ready.\n${notice}` : `The model ${model} is ready.` };
}

// ---- feeds

function checkCountry(country: string | undefined): string | null {
  if (country === undefined) return null;
  if (!/^[A-Za-z]{3}$/.test(country)) throw new CliError('feed_url_invalid', 'The country must be a three letter code such as GBR.');
  return country.toUpperCase();
}

async function feedsAdd(ctx: Ctx, args: string[]): Promise<Result> {
  const url = args[0] ?? '';
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
    host = u.hostname;
  } catch {
    throw new CliError('feed_url_invalid', 'The feed address must be a web address starting with http:// or https://.');
  }
  const countryCode = checkCountry(ctx.values.country);
  // Without a name, the first fetch takes the feed's own title; until then the publisher goes by the host.
  const publicationName = ctx.values.name ?? '';
  return withStore(ctx, (store) => {
    const { created } = store.upsertFeed({
      feedUrl: url,
      publicationName,
      publicationUrl: null,
      countryCode,
      feedLanguageCode: ctx.values.language ?? null,
      publisher: { name: publicationName || host, countryCode, websiteUrl: null },
    });
    return { data: { feed: url, created }, text: `${created ? 'Added' : 'Updated'} ${url}.` };
  });
}

interface SeedFeed {
  uri: string;
  language_code?: string;
  is_valid?: boolean;
  gated?: boolean;
  bot_protection?: boolean;
}

/** This setup is built for a small set of sources. */
export const DEFAULT_LOAD_LIMIT = 20;
export const MANY_FEEDS_NOTE_AT = 50;

/** A feed the list marks as working, open and not behind bot protection. */
const usable = (feed: SeedFeed) => feed.is_valid !== false && feed.gated !== true && feed.bot_protection !== true;
interface SeedPublication {
  publication_name: string;
  publication_website_uri?: string | null;
  publication_rss_feed_uris: SeedFeed[];
}

type Selector = { kind: 'all' | 'url' | 'country' | 'language'; value: string; raw: string };

function parseSelector(raw: string): Selector {
  if (/^https?:\/\//.test(raw)) return { kind: 'url', value: raw, raw };
  if (raw === 'all') return { kind: 'all', value: raw, raw };
  const m = /^(country|language):(.+)$/.exec(raw);
  if (!m) throw new CliError('selector_invalid', `"${raw}" is not a feed address, country:<ALPHA3>, language:<code> or all.`);
  const kind = m[1] as 'country' | 'language';
  return { kind, value: kind === 'country' ? m[2]!.toUpperCase() : m[2]!.toLowerCase(), raw };
}

function selects(sel: Selector, feed: SeedFeed, country: string): boolean {
  if (sel.kind === 'all') return true;
  if (sel.kind === 'url') return feed.uri === sel.value;
  if (sel.kind === 'country') return country.toUpperCase() === sel.value;
  const lang = (feed.language_code ?? '').toLowerCase();
  return lang === sel.value || lang.startsWith(`${sel.value}-`);
}

/** The shipped list sits at apps/mera-scripts/seed-data, a few folders above the source or the bundle. */
function defaultFeedFile(): string {
  const tail = join('apps', 'mera-scripts', 'seed-data', 'active-feeds-auto-generated.json');
  for (let dir = dirname(fileURLToPath(import.meta.url)), i = 0; i < 6; i++, dir = dirname(dir)) {
    if (existsSync(join(dir, tail))) return join(dir, tail);
  }
  return resolve(tail);
}

async function feedsLoad(ctx: Ctx): Promise<Result> {
  const only = ctx.values.only ?? [];
  if (only.length === 0) {
    throw new CliError('feeds_choose', 'Loading every feed takes a long time and fetches ten thousand sites, so say which ones. Use --only all to load them all.');
  }
  const selectors = only.map(parseSelector);
  const file = ctx.values.file ?? defaultFeedFile();
  let data: Record<string, SeedPublication[]>;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new CliError('selector_invalid', `The feed list ${file} could not be read.`);
  }
  const loadAll = selectors.some((s) => s.kind === 'all');
  const limit = loadAll ? Infinity : whole('limit', ctx.values.limit, DEFAULT_LOAD_LIMIT)!;
  // A feed named by its address always loads. Otherwise: in the list's own order, the first
  // usable feed of each publication, up to the limit.
  const wanted: { pub: SeedPublication; feed: SeedFeed; country: string }[] = [];
  const urlSelectors = selectors.filter((s) => s.kind === 'url');
  const broad = selectors.filter((s) => s.kind !== 'url');
  let picked = 0;
  for (const [country, pubs] of Object.entries(data)) {
    for (const pub of pubs) {
      let tookOne = false;
      for (const feed of pub.publication_rss_feed_uris) {
        if (urlSelectors.some((s) => selects(s, feed, country))) {
          wanted.push({ pub, feed, country });
          continue;
        }
        if (tookOne || picked >= limit || !usable(feed) || !broad.some((s) => selects(s, feed, country))) continue;
        wanted.push({ pub, feed, country });
        tookOne = true;
        picked++;
      }
    }
  }
  if (loadAll) {
    ctx.progress({ event: 'warning', message: `This setup is meant for 10 to 20 sources. Loading all ${wanted.length} feeds makes every ingest slow; for that many, use the server setup in docs/self-host.md.` });
  }
  const empty = selectors.filter((s) => s.kind !== 'all' && !Object.entries(data).some(([c, ps]) => ps.some((p) => p.publication_rss_feed_uris.some((f) => selects(s, f, c)))));
  if (empty.length > 0) throw new CliError('selector_invalid', `Nothing in ${file} matches ${empty.map((s) => s.raw).join(', ')}.`);
  return withStore(ctx, (store) => {
    let created = 0;
    for (const { pub, feed, country } of wanted) {
      const site = pub.publication_website_uri ?? null;
      const r = store.upsertFeed({
        feedUrl: feed.uri,
        publicationName: pub.publication_name,
        publicationUrl: site,
        countryCode: country,
        feedLanguageCode: feed.language_code ?? null,
        publisher: { name: pub.publication_name, countryCode: country, websiteUrl: site },
      });
      if (r.created) created++;
    }
    return { data: { loaded: wanted.length, created, updated: wanted.length - created }, text: `Loaded ${wanted.length} feeds, ${created} new.` };
  });
}

const failedStatus = (s: string | null) => s === 'failed' || s === 'refused';

function feedsList(ctx: Ctx, store: Store): Result {
  const rows = store.listFeeds().filter((f) => !ctx.values.failed || failedStatus(f.last_fetch_status));
  const feeds = rows.map((f) => ({
    url: f.feed_url,
    name: f.publication_name || new URL(f.feed_url).hostname,
    status: f.last_fetch_status ?? 'not_fetched',
    reason: f.last_fetch_error,
    // The store keeps the time of the last fetch, so a feed whose last fetch failed has no known success time.
    lastSuccess: f.last_ok_at,
  }));
  const text = feeds.length === 0 ? 'No feeds.' : feeds.map((f) => `${f.url}  ${f.status}${f.reason ? ` (${f.reason})` : ''}  last success ${f.lastSuccess ?? 'never'}`).join('\n');
  return { data: { feeds }, text };
}

// ---- ingest

async function ingest(ctx: Ctx, store: Store): Promise<Result> {
  requireContact(store);
  const all = store.listFeeds({ activeOnly: true });
  if (all.length === 0) throw new CliError('feeds_none', 'There are no feeds to fetch yet.');
  let feedIds: string[] | undefined;
  if (ctx.values.feed?.length) {
    const byUrl = new Map(store.listFeeds().map((f) => [f.feed_url, f.id]));
    feedIds = ctx.values.feed.map((u) => {
      const id = byUrl.get(u);
      if (!id) throw new CliError('feed_unknown', `${u} is not one of the stored feeds.`);
      return id;
    });
  }
  const embedder = await buildEmbedder(embedderRequest(ctx, { download: true }));
  const summary = await runIngest({
    store,
    dbPath: ctx.home.db,
    embedder,
    allowHosts: allowHostsOf(ctx.settings),
    feedIds,
    onEvent: (e: IngestEvent) => ctx.progress({ ...e }),
  });
  const counts = { run: summary.run, feedsOk: summary.feedsOk, feedsFailed: summary.feedsFailed, articlesNew: summary.articlesNew };
  if (summary.feedsFailed > 0) {
    const list = summary.failed.map((f) => `${new URL(f.feed).host} (${f.reason})`).join('; ');
    throw new CliError('feeds_failed', `${summary.feedsFailed} of ${summary.feedsOk + summary.feedsFailed} feeds failed, ${summary.articlesNew} new articles stored. Failed: ${list}.`, {}, { ...counts, failed: summary.failed });
  }
  return { data: counts, text: `Fetched ${summary.feedsOk} feeds, ${summary.articlesNew} new articles.` };
}

// ---- search

async function search(ctx: Ctx, store: Store, query: string): Promise<Result> {
  if (!query.trim()) throw usage('Use search "<text>" [--limit N].');
  const limit = whole('limit', ctx.values.limit, 10)!;
  const searchFn = ctx.deps.search ?? (await loadSearch());
  const embedder = await buildEmbedder(embedderRequest(ctx));
  if (store.embeddingModel()) store.assertEmbeddingModel({ id: embedder.model, dims: embedder.dims });
  const { hits, empty } = await searchFn(store, embedder, query, { limit });
  if (empty) throw new CliError(empty, empty === 'no_articles_yet' ? 'There are no articles yet.' : 'No article matches those words.');
  const text = hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.publicationName}, ${h.pubDate.slice(0, 10)}\n   ${h.articleUrl}`).join('\n');
  return { data: { hits }, text };
}

// ---- status

const ago = (iso: string, now = Date.now()): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'} ago`;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return unit(minutes, 'minute');
  if (minutes < 2880) return unit(Math.round(minutes / 60), 'hour');
  return unit(Math.round(minutes / 1440), 'day');
};

function status(ctx: Ctx, store: Store): Result {
  const feeds = store.listFeeds({ activeOnly: true });
  const failedFeeds = feeds.filter((f) => failedStatus(f.last_fetch_status));
  const okFeeds = feeds.filter((f) => f.last_fetch_status === 'ok' || f.last_fetch_status === 'not_modified');
  // The rest have never been fetched: added since the last fetch, or a fetch is under way.
  const notFetched = feeds.length - okFeeds.length - failedFeeds.length;
  const fetching = writeLockHolder(ctx.home.db) !== null;
  const articles = store.articleCount();
  const last = store.lastIngestAt();
  const problems: { code: string; message: string; fix: string }[] = [...store.integrityProblems()];
  if (!store.getMeta(CONTACT_KEY)?.trim()) {
    problems.push({ code: 'contact_missing', message: 'No contact is set, so ingest will refuse to run.', fix: ERRORS.contact_missing!.fix! });
  }
  const note =
    feeds.length > MANY_FEEDS_NOTE_AT
      ? `This setup is built for 10 to 20 feeds and now has ${feeds.length}. For more, the server setup in docs/self-host.md fits better.`
      : null;
  const contactProblem = problems.find((p) => p.code === 'contact_missing');
  const other = problems.find((p) => p.code !== 'contact_missing');
  let next: string;
  if (feeds.length === 0) next = ERRORS.feeds_choose!.fix!;
  else if (contactProblem) next = contactProblem.fix;
  else if (other) next = other.fix;
  else if (!last) next = `${CMD} ingest`;
  else if (failedFeeds.length > 0) next = `${CMD} feeds list --failed`;
  else next = `${CMD} ingest`;

  const failed = failedFeeds.map((f) => ({ feed: f.feed_url, host: new URL(f.feed_url).host, reason: f.last_fetch_error ?? f.last_fetch_status, lastSuccess: f.last_ok_at }));
  const head =
    feeds.length === 0
      ? 'No feeds yet.'
      : !last
        ? `${feeds.length.toLocaleString('en-US')} feeds, nothing fetched yet.`
        : `${failedFeeds.length === 0 ? 'Working' : okFeeds.length === 0 ? 'Not working' : 'Partly working'}. ${articles.toLocaleString('en-US')} articles from ${okFeeds.length} of ${feeds.length} feeds${
            notFetched > 0 ? `, ${notFetched} not fetched yet` : ''
          }. Last fetch ${ago(last)}.${fetching ? ' A fetch is running now.' : ''}`;
  const text = [head, ...(note ? [note] : []), ...failed.map((f) => `${f.host} (${String(f.reason).replace(/\.$/, '')}), last worked ${f.lastSuccess ? ago(f.lastSuccess) : 'never'}`), ...problems.map((p) => p.message), `Next: ${next}`].join('\n');
  return { data: { articles, feeds: { total: feeds.length, ok: okFeeds.length, failed: failed.length, notFetched }, fetching, lastIngestAt: last, failed, problems, ...(note ? { note } : {}), next }, text };
}

// ---- prune and reembed

function prune(ctx: Ctx, store: Store): Result {
  const days = whole('older-than', ctx.values['older-than']);
  if (days === undefined) throw usage('Use prune --older-than <days>.');
  const last = store.lastIngestAt();
  if (!last) throw new CliError('no_ingest_yet', 'Nothing has been fetched yet, so there is no date to count back from.');
  const removed = store.prune(new Date(Date.parse(last) - days * 86_400_000).toISOString());
  return { data: { removed }, text: `Removed ${removed} articles older than ${days} days.` };
}

async function reembed(ctx: Ctx, store: Store): Promise<Result> {
  const embedder = await buildEmbedder(embedderRequest(ctx, { model: ctx.values.model }));
  const target = { id: embedder.model, dims: embedder.dims };
  const release = acquireWriteLock(ctx.home.db);
  try {
    store.beginReembed(target);
    const total = store.articleCount();
    let done = 0;
    for (;;) {
      const pending = store.pendingReembed(32);
      if (pending.length === 0) break;
      const vectors = await embedder.embedPassages(pending.map((a) => (a.description ? `${a.title}\n${a.description}` : a.title)));
      store.setNextEmbeddings(pending.map((a, i) => ({ id: a.id, vector: vectors[i]! })));
      done += pending.length;
      ctx.progress({ event: 'reembed', done, total });
    }
    store.finishReembed(target);
  } finally {
    release();
  }
  return { data: { model: target.id, dims: target.dims }, text: `Every article now uses ${target.id}.` };
}

// ---- serve

async function serve(ctx: Ctx, store: Store): Promise<Result> {
  const serveFn = ctx.deps.serve ?? (await loadServe());
  const embedder = await buildEmbedder(embedderRequest(ctx, { download: true }));
  const every = whole('every', ctx.values.every);
  const ingest = every
    ? () => {
        requireContact(store);
        return runIngest({ store, dbPath: ctx.home.db, embedder, allowHosts: allowHostsOf(ctx.settings), onEvent: (e: IngestEvent) => ctx.progress({ ...e }) });
      }
    : undefined;
  await serveFn({ store, embedder, port: whole('port', ctx.values.port), every, ingest, onEvent: ctx.progress });
  return { data: {}, text: 'Stopped.' };
}

