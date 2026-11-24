import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DEFAULT_MODEL } from '../src/embed/models.ts';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { EmbedError } from '../src/embed/embedder.ts';
import { ERRORS } from '../src/cli/errors.ts';
import { run, type Deps, type Io } from '../src/cli/run.ts';
import { Store } from '../src/store/store.ts';

const root = mkdtempSync(join(tmpdir(), 'mera-news-local-cli-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const newHome = () => join(root, `home-${++n}`);
const FIXTURE = new URL('./fixtures/cli/feeds.json', import.meta.url).pathname;

const rss = (items: { title: string; link: string; description: string; pubDate: string }[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>${items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link><description>${i.description}</description><pubDate>${i.pubDate}</pubDate></item>`)
    .join('')}</channel></rss>`;
const HARBOUR = rss([
  { title: 'Brightwater orders forty electric buses for its city routes', link: 'https://harbour.example.test/buses', description: 'The council signed the contract on Tuesday after a long debate about charging depots.', pubDate: new Date().toUTCString() },
  { title: 'Lighthouse reopens to visitors after three years of work', link: 'https://harbour.example.test/lighthouse', description: 'Volunteers restored the lamp room and the stairs of the old tower.', pubDate: new Date().toUTCString() },
  { title: 'An archive item from long ago', link: 'https://harbour.example.test/archive', description: 'Kept, because nothing expires in the one-computer setup.', pubDate: 'Fri, 01 Mar 2019 10:00:00 GMT' },
]);

let server: Server;
let base = '';
before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok.xml') res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(HARBOUR);
    else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

interface Out {
  code: number | null;
  stdout: string;
  stderr: string;
  json: any;
}

const FAKE = (dims: number) => ({ MERA_NEWS_LOCAL_TEST_EMBEDDER: `fake:${dims}`, MERA_NEWS_LOCAL_ALLOW_FAKE: '1' });

/** Runs the real command line as a child process; stdout is a pipe, so it answers in JSON. */
function cli(home: string, args: string[], env: Record<string, string> = FAKE(8)): Promise<Out> {
  return new Promise((resolve) => {
    const clean = { ...process.env };
    delete clean.MERA_NEWS_LOCAL_TEST_EMBEDDER;
    delete clean.MERA_NEWS_LOCAL_ALLOW_FAKE;
    delete clean.MERA_NEWS_LOCAL_HOME;
    const child = spawn(process.execPath, ['--import', './scripts/register.mjs', 'src/cli/main.ts', '--home', home, ...args], { cwd: new URL('..', import.meta.url).pathname, env: { ...clean, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      let json: unknown = null;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code, stdout, stderr, json });
    });
  });
}

/** Runs the command in this process, with a terminal or not and fakes for the parts that are not built yet. */
async function inProcess(home: string, args: string[], deps: Partial<Deps> = {}, tty = false) {
  let stdout = '';
  let stderr = '';
  const io: Io = { out: (t) => (stdout += t), err: (t) => (stderr += t), tty };
  const code = await run(['--home', home, ...args], io, { env: FAKE(8), ...deps });
  return { code, stdout, stderr };
}

/** A home with the loopback feeds and the loopback allowed. */
async function readyHome(feeds: string[] = ['/ok.xml']) {
  const home = newHome();
  assert.equal((await cli(home, ['config', 'set', 'feeds.allowHosts', new URL(base).host])).code, 0);
  for (const f of feeds) assert.equal((await cli(home, ['feeds', 'add', `${base}${f}`, '--country', 'gbr'])).code, 0);
  return home;
}

const countArticles = (home: string) => {
  const store = new Store(join(home, 'news.db'));
  try {
    return store.articleCount();
  } finally {
    store.close();
  }
};

describe('refusals', () => {
  const expectRefusal = (out: Out, code: string, exit: number) => {
    assert.equal(out.code, exit, out.stdout);
    assert.equal(out.json.ok, false);
    assert.equal(out.json.code, code);
    assert.equal(typeof out.json.message, 'string');
    assert.equal(out.json.fix, ERRORS[code]!.fix?.replace('{model}', out.json.fix?.split(' ').at(-1)) ?? null);
  };

  it('feeds_none, feeds_choose, selector_invalid and feed_url_invalid', async () => {
    const home = newHome();
    expectRefusal(await cli(home, ['ingest']), 'feeds_none', 2);
    expectRefusal(await cli(home, ['feeds', 'load', '--file', FIXTURE]), 'feeds_choose', 2);
    expectRefusal(await cli(home, ['feeds', 'load', '--file', FIXTURE, '--only', 'country:ZZZ']), 'selector_invalid', 1);
    expectRefusal(await cli(home, ['feeds', 'load', '--file', FIXTURE, '--only', 'nonsense']), 'selector_invalid', 1);
    expectRefusal(await cli(home, ['feeds', 'add', 'not a url']), 'feed_url_invalid', 1);
    assert.equal(new Store(join(home, 'news.db')).listFeeds().length, 0, 'feeds load without --only loads nothing');
  });

  it('no_ingest_yet on prune, model_missing, model_unknown and the test embedder switch', async () => {
    const home = newHome();
    expectRefusal(await cli(home, ['prune', '--older-than', '30']), 'no_ingest_yet', 2);
    const missing = await cli(home, ['reembed'], {});
    expectRefusal(missing, 'model_missing', 2);
    assert.equal(missing.json.fix, `mera-news-local model download --model ${DEFAULT_MODEL}`);
    await cli(home, ['config', 'set', 'embedder.model', 'nope']);
    expectRefusal(await cli(home, ['reembed'], {}), 'model_unknown', 1);
    expectRefusal(await cli(home, ['reembed'], { MERA_NEWS_LOCAL_TEST_EMBEDDER: 'fake:8' }), 'test_embedder_refused', 1);
  });

  it('store_busy while another writer holds the lock, store_too_old for a newer file, usage for a bad flag', async () => {
    const home = await readyHome();
    writeFileSync(join(home, 'news.db.lock'), `${process.pid}\n`);
    expectRefusal(await cli(home, ['ingest']), 'store_busy', 2);
    rmSync(join(home, 'news.db.lock'));
    const store = new Store(join(home, 'news.db'));
    store.db.exec('PRAGMA user_version = 99');
    store.close();
    expectRefusal(await cli(home, ['status']), 'store_too_old', 2);
    expectRefusal(await cli(newHome(), ['status', '--nope']), 'usage', 1);
  });

  it('wrong_model: the stored articles keep their model, with the fix from the store', async () => {
    const home = await readyHome();
    assert.equal((await cli(home, ['ingest'])).code, 0);
    const out = await cli(home, ['ingest'], FAKE(16));
    assert.equal(out.code, 2);
    assert.equal(out.json.code, 'wrong_model');
    assert.equal(out.json.fix, 'mera-news-local reembed --model fake-16');
  });

  it('embedder errors take the table fix when their own advice is a sentence', async () => {
    const home = newHome();
    const out = await inProcess(home, ['search', 'x'], {
      search: async () => {
        throw new EmbedError('embed_endpoint_unreachable', 'It could not be reached.', 'Check the base URL.');
      },
    });
    assert.equal(out.code, 2);
    assert.deepEqual(JSON.parse(out.stdout), { ok: false, code: 'embed_endpoint_unreachable', message: 'It could not be reached.', fix: 'mera-news-local config show' });
    const dims = await inProcess(home, ['search', 'x'], { search: async () => { throw new EmbedError('embed_dims_mismatch', 'Wrong size.', 'Set it.'); } });
    assert.equal(dims.code, 2);
  });

  it('serve answers the pod operations on 127.0.0.1 and stops on a signal', async () => {
    const home = newHome();
    await cli(home, ['config', 'set', 'feeds.allowHosts', new URL(base).host]);
    await cli(home, ['feeds', 'add', `${base}/ok.xml`]);
    await cli(home, ['ingest']);
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(p));
      });
    });
    const clean = { ...process.env };
    delete clean.MERA_NEWS_LOCAL_HOME;
    const child = spawn(process.execPath, ['--import', './scripts/register.mjs', 'src/cli/main.ts', '--home', home, 'serve', '--port', String(port)], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...clean, ...FAKE(8) },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        let err = '';
        child.stderr.on('data', (c) => {
          err += c;
          if (err.includes('"serve_start"')) resolve();
        });
        child.once('exit', () => reject(new Error(`serve exited: ${err}`)));
      });
      const res = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ searchNews(query: "Lighthouse", limit: 3) { _id title_en } newsServerStatus { lastArticleAt } }' }),
      });
      const body = (await res.json()) as { data: { searchNews: { title_en: string }[]; newsServerStatus: { lastArticleAt: string | null } } };
      assert.equal(body.data.searchNews[0]!.title_en, 'Lighthouse reopens to visitors after three years of work');
      assert.ok(body.data.newsServerStatus.lastArticleAt);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
});

describe('output', () => {
  it('prints JSON when piped or with --json, and short text on a terminal', async () => {
    const home = newHome();
    const piped = await inProcess(home, ['status']);
    assert.equal(JSON.parse(piped.stdout).ok, true);
    const forced = await inProcess(home, ['status', '--json'], {}, true);
    assert.equal(JSON.parse(forced.stdout).ok, true);
    const text = await inProcess(home, ['status'], {}, true);
    assert.match(text.stdout, /^No feeds yet\.\n/);
    assert.match(text.stdout, /Next: mera-news-local feeds load --only country:GBR/);
    const refused = await inProcess(home, ['prune', '--older-than', '3'], {}, true);
    assert.match(refused.stdout, /^Nothing has been fetched yet.*\nFix: mera-news-local ingest\n$/);
  });

  it('keeps progress on stderr, one JSON line per event, and stdout one JSON document', async () => {
    const home = await readyHome();
    const out = await cli(home, ['ingest']);
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.equal(out.json.ok, true);
    assert.equal(out.json.articlesNew, 3);
    const events = out.stderr.trim().split('\n').map((l) => JSON.parse(l).event);
    assert.deepEqual(events, ['ingest_start', 'feed', 'ingest_end']);
    assert.ok(!out.stdout.includes('"event"'));
  });
});

describe('ingest and status', () => {
  it('ingest twice stores no duplicates; status shows a working store', async () => {
    const home = await readyHome();
    assert.equal((await cli(home, ['status'])).json.next, 'mera-news-local ingest');
    await cli(home, ['ingest']);
    const second = await cli(home, ['ingest']);
    assert.equal(second.code, 0);
    assert.equal(second.json.articlesNew, 0);
    assert.equal(countArticles(home), 3);
    const status = await cli(home, ['status']);
    assert.equal(status.code, 0);
    assert.equal(status.json.articles, 3);
    assert.deepEqual(status.json.feeds, { total: 1, ok: 1, failed: 0, notFetched: 0 });
    assert.equal(status.json.fetching, false);
    assert.deepEqual(status.json.problems, []);
    const text = await inProcess(home, ['status'], {}, true);
    assert.match(text.stdout, /^Working\. 3 articles from 1 of 1 feeds\. Last fetch just now\.\nNext: mera-news-local ingest\n$/);

    // A feed added since the fetch is counted as not fetched yet, and a running fetch is named.
    await cli(home, ['feeds', 'add', 'https://later.example.test/rss.xml']);
    writeFileSync(join(home, 'news.db.lock'), `${process.pid}\n`);
    try {
      const later = await cli(home, ['status']);
      assert.deepEqual(later.json.feeds, { total: 2, ok: 1, failed: 0, notFetched: 1 });
      assert.equal(later.json.fetching, true);
      const laterText = await inProcess(home, ['status'], {}, true);
      assert.match(laterText.stdout, /^Working\. 3 articles from 1 of 2 feeds, 1 not fetched yet\. Last fetch just now\. A fetch is running now\.\n/);
    } finally {
      rmSync(join(home, 'news.db.lock'), { force: true });
    }
  });

  it('exits 3 when one feed fails, keeps the good feed, and status lists the failed feed', async () => {
    const home = await readyHome(['/ok.xml', '/missing.xml']);
    const out = await cli(home, ['ingest']);
    assert.equal(out.code, 3, out.stdout);
    assert.equal(out.json.code, 'feeds_failed');
    assert.equal(out.json.fix, 'mera-news-local feeds list --failed');
    assert.equal(out.json.articlesNew, 3);
    assert.equal(out.json.failed.length, 1);
    const status = await cli(home, ['status']);
    assert.deepEqual(status.json.feeds, { total: 2, ok: 1, failed: 1, notFetched: 0 });
    assert.equal(status.json.next, 'mera-news-local feeds list --failed');
    assert.match((await inProcess(home, ['status'], {}, true)).stdout, /^Partly working\. 3 articles from 1 of 2 feeds\..*\n127\.0\.0\.1:\d+ \(HTTP 404\), last worked never\n/s);
    const failed = await cli(home, ['feeds', 'list', '--failed']);
    assert.deepEqual(failed.json.feeds.map((f: { url: string }) => f.url), [`${base}/missing.xml`]);
  });

  it('ingest --feed fetches only that feed', async () => {
    const home = await readyHome(['/ok.xml', '/missing.xml']);
    const out = await cli(home, ['ingest', '--feed', `${base}/ok.xml`]);
    assert.equal(out.code, 0, out.stdout);
    assert.equal(out.json.feedsOk, 1);
    assert.equal((await cli(home, ['ingest', '--feed', 'http://nowhere.test/x'])).json.code, 'feed_unknown');
  });

  it('prune drops older articles, counting back from the last ingest', async () => {
    const home = await readyHome();
    await cli(home, ['ingest']);
    const out = await cli(home, ['prune', '--older-than', '30']);
    assert.equal(out.code, 0);
    assert.equal(out.json.removed, 1);
    assert.equal(countArticles(home), 2);
  });

  it('reembed moves every article from fake:8 to fake:16', async () => {
    const home = await readyHome();
    await cli(home, ['ingest']);
    const out = await cli(home, ['reembed', '--model', 'fake-16'], FAKE(16));
    assert.equal(out.code, 0, out.stdout + out.stderr);
    assert.deepEqual([out.json.model, out.json.dims], ['fake-16', 16]);
    assert.match(out.stderr.trim().split('\n').at(-1)!, /"event":"reembed","done":3,"total":3/);
    const store = new Store(join(home, 'news.db'));
    assert.deepEqual(store.embeddingModel(), { id: 'fake-16', dims: 16 });
    assert.deepEqual(store.integrityProblems(), []);
    store.close();
    assert.equal((await cli(home, ['ingest'], FAKE(16))).code, 0);
  });
});

describe('feeds', () => {
  it('loads at most 20 usable feeds by default, one per publication, and warns before loading all', async () => {
    const list = {
      XXA: Array.from({ length: 60 }, (_, i) => ({
        publication_name: `Paper ${i}`,
        publication_website_uri: `https://p${i}.example.test/`,
        publication_rss_feed_uris: [
          { uri: `https://p${i}.example.test/a.xml`, language_code: 'en', is_valid: i % 10 !== 0, gated: i === 3 },
          { uri: `https://p${i}.example.test/b.xml`, language_code: 'en', is_valid: true },
        ],
      })),
    };
    const file = join(root, 'many-feeds.json');
    writeFileSync(file, JSON.stringify(list));
    const home = newHome();
    const first = await cli(home, ['feeds', 'load', '--file', file, '--only', 'country:XXA']);
    assert.equal(first.json.loaded, 20);
    const urls = (await cli(home, ['feeds', 'list'])).json.feeds.map((f: { url: string }) => f.url);
    assert.ok(urls.includes('https://p0.example.test/b.xml'), 'an invalid feed is passed over for the next one of that paper');
    assert.ok(urls.includes('https://p3.example.test/b.xml'), 'a gated feed is passed over too');
    assert.equal(new Set(urls.map((u: string) => new URL(u).host)).size, 20);
    assert.equal((await cli(newHome(), ['feeds', 'load', '--file', file, '--only', 'country:XXA', '--limit', '5'])).json.loaded, 5);

    const all = await cli(home, ['feeds', 'load', '--file', file, '--only', 'all']);
    assert.equal(all.json.loaded, 60);
    assert.match(all.stderr, /"event":"warning".*meant for 10 to 20 sources/);
    const status = await cli(home, ['status']);
    assert.match(status.json.note, /built for 10 to 20 feeds and now has 60/);
  });


  it('load --only language:ja takes the Japanese feed from the list file and nothing else', async () => {
    const home = newHome();
    const out = await cli(home, ['feeds', 'load', '--file', FIXTURE, '--only', 'language:ja']);
    assert.equal(out.code, 0, out.stdout);
    assert.deepEqual([out.json.loaded, out.json.created], [1, 1]);
    const list = await cli(home, ['feeds', 'list']);
    assert.deepEqual(list.json.feeds.map((f: { url: string }) => f.url), ['https://tokyo.example.test/feed.xml']);
    const again = await cli(home, ['feeds', 'load', '--file', FIXTURE, '--only', 'language:en', '--only', 'country:jpn']);
    assert.deepEqual([again.json.loaded, again.json.created], [2, 1], 'en also matches en-GB, the selector may repeat, and a publication gives one feed');
  });

  it('the shipped list loads by country with no file argument', async () => {
    const out = await cli(newHome(), ['feeds', 'load', '--only', 'country:GBR']);
    assert.equal(out.code, 0, out.stdout);
    assert.ok(out.json.loaded > 0);
  });
});

describe('search and serve seams', () => {
  const hit = { id: '1', title: 'Buses', articleUrl: 'https://a.test/1', publicationName: 'Gazette', pubDate: '2026-11-20T10:00:00.000Z', languageCode: 'en' };

  it('passes the text and limit to the search and prints the hits', async () => {
    const calls: unknown[] = [];
    const search = async (_s: unknown, _e: unknown, query: string, opts: { limit: number }) => {
      calls.push([query, opts]);
      return { hits: [hit], empty: null };
    };
    const home = newHome();
    const json = await inProcess(home, ['search', 'electric', 'buses', '--limit', '5'], { search });
    assert.deepEqual(calls, [['electric buses', { limit: 5 }]]);
    assert.deepEqual(JSON.parse(json.stdout).hits, [hit]);
    const text = await inProcess(home, ['search', 'buses'], { search }, true);
    assert.equal(text.stdout, '1. Buses\n   Gazette, 2026-11-20\n   https://a.test/1\n');
  });

  it('refuses an empty store with exit 2 and an unmatched query with exit 0', async () => {
    const home = newHome();
    const none = await inProcess(home, ['search', 'x'], { search: async () => ({ hits: [], empty: 'no_articles_yet' }) });
    assert.equal(none.code, 2);
    assert.equal(JSON.parse(none.stdout).fix, 'mera-news-local ingest');
    const nomatch = await inProcess(home, ['search', 'x'], { search: async () => ({ hits: [], empty: 'no_match' }) });
    assert.equal(nomatch.code, 0);
    assert.equal(JSON.parse(nomatch.stdout).code, 'no_match');
  });

  it('hands serve the store, an embedder, the port and the interval', async () => {
    let seen: any;
    const out = await inProcess(newHome(), ['serve', '--port', '8123', '--every', '15'], {
      serve: async (o) => {
        seen = o;
        o.onEvent({ event: 'listening' });
      },
    });
    assert.equal(out.code, 0, out.stdout);
    assert.deepEqual([seen.port, seen.every, seen.embedder.model], [8123, 15, 'fake-8']);
    assert.match(out.stderr, /"event":"listening"/);
  });
});

describe('the embedding key', () => {
  const KEY = 'sk-test-secret-key-12345';

  it('is never printed: not on set, not on show, not in an error, not in progress', async () => {
    const home = newHome();
    const set = await cli(home, ['config', 'set', 'embedder.key', KEY]);
    assert.equal(set.code, 0);
    assert.ok(!(set.stdout + set.stderr).includes(KEY));
    const show = await cli(home, ['config', 'show']);
    assert.equal(show.json['embedder.key'], 'set');
    assert.ok(!(show.stdout + show.stderr).includes(KEY));
    assert.ok(!(await inProcess(home, ['config', 'show'], {}, true)).stdout.includes(KEY));
    assert.equal(statSync(join(home, 'settings.json')).mode & 0o777, 0o600);
    const failing = await inProcess(home, ['search', 'x'], { search: async () => { throw new Error(`The endpoint rejected ${KEY}`); } });
    assert.ok(!failing.stdout.includes(KEY) && !failing.stderr.includes(KEY));
    assert.equal(failing.code, 1);
    assert.equal((await cli(newHome(), ['config', 'show'])).json['embedder.key'], 'unset');
  });
});
