// Builds the frozen feed sample: one polite GET per feed, never retried.
// usage: node sample.mjs --dir <path> --user-agent "<string>"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Parser from 'rss-parser';

const { values } = parseArgs({
  options: { dir: { type: 'string' }, 'user-agent': { type: 'string' } },
});
if (!values.dir || !values['user-agent']) {
  console.error('usage: node sample.mjs --dir <path> --user-agent "<string>" (both required)');
  process.exit(1);
}
const UA = values['user-agent'];
const LANGS = ['en', 'es', 'fr', 'de', 'pt', 'hi'];
const PER_LANG = 10;
const GAP_MS = 1000;
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;

const feedFile = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../apps/mera-scripts/seed-data/active-feeds-auto-generated.json',
);

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic pick: sort for a stable order, seeded shuffle, one feed per host.
function pickFeeds() {
  const data = JSON.parse(readFileSync(feedFile, 'utf8'));
  const byLang = Object.fromEntries(LANGS.map((l) => [l, []]));
  for (const pubs of Object.values(data)) {
    for (const pub of pubs) {
      for (const f of pub.publication_rss_feed_uris ?? []) {
        if (f.is_valid && f.uri?.startsWith('https://') && byLang[f.language_code]) {
          byLang[f.language_code].push(f.uri);
        }
      }
    }
  }
  const rand = mulberry32(20260101);
  const hosts = new Set();
  const picked = [];
  for (const lang of LANGS) {
    const pool = [...new Set(byLang[lang])].sort();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    let n = 0;
    for (const url of pool) {
      if (n >= PER_LANG) break;
      const host = new URL(url).hostname;
      if (hosts.has(host)) continue;
      hosts.add(host);
      picked.push({ feedUrl: url, lang });
      n++;
    }
    if (n < PER_LANG) console.warn(`language ${lang}: only ${n} usable feeds`);
  }
  return picked;
}

async function fetchBody(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw Object.assign(new Error(`http ${res.status}`), { status: res.status });
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      await res.body.cancel();
      throw new Error('body over 5 MiB');
    }
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), status: res.status };
}

const strip = (s) =>
  (s ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1000);

const out = join(values.dir, 'sample');
mkdirSync(out, { recursive: true });
const itemsFile = join(out, 'items.json');
const logFile = join(out, 'fetch-log.json');
const items = existsSync(itemsFile) ? JSON.parse(readFileSync(itemsFile, 'utf8')) : [];
const log = existsSync(logFile) ? JSON.parse(readFileSync(logFile, 'utf8')) : {};
const feeds = pickFeeds();
const parser = new Parser();

for (const { feedUrl, lang } of feeds) {
  if (log[feedUrl]) continue;
  const started = Date.now();
  try {
    const { text, status } = await fetchBody(feedUrl);
    const feed = await parser.parseString(text);
    const got = (feed.items ?? []).map((it) => ({
      feedUrl,
      lang,
      title: strip(it.title),
      description: strip(it.contentSnippet ?? it.content ?? it.summary),
      link: it.link ?? null,
      pubDate: it.isoDate ?? it.pubDate ?? null,
    })).filter((it) => it.title);
    items.push(...got);
    log[feedUrl] = { lang, status, ok: true, items: got.length };
  } catch (e) {
    log[feedUrl] = { lang, status: e.status ?? null, ok: false, items: 0, error: String(e.message ?? e) };
  }
  writeFileSync(itemsFile, JSON.stringify(items));
  writeFileSync(logFile, JSON.stringify(log, null, 1));
  console.log(`${log[feedUrl].ok ? 'ok  ' : 'fail'} ${lang} ${feedUrl} (${Date.now() - started} ms)`);
  await new Promise((r) => setTimeout(r, GAP_MS));
}

const ok = feeds.filter((f) => log[f.feedUrl]?.ok).length;
const perLang = {};
for (const it of items) perLang[it.lang] = (perLang[it.lang] ?? 0) + 1;
console.log(`feeds ok ${ok}/${feeds.length}, items ${items.length}, per language ${JSON.stringify(perLang)}`);
