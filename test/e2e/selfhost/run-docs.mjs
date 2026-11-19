#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Follows the self-hosting guide: every `sh` block runs, in order, exactly as
 * written. The runner changes three settings, skips five commands that name
 * what the machine already has, and never edits the guide. A command it does
 * not recognise runs and fails, which is how a guide that has drifted shows.
 *
 *   node test/e2e/selfhost/run-docs.mjs docs/self-host.md [--lint | --dry-run]
 *
 * A run needs MONGODB_URI (a database named mera-news) in its environment, and
 * leaves the "in a new terminal" processes running; their pids and logs are
 * under SELFHOST_LOG_DIR (default: a new temporary directory).
 */

export const REFUSED_SOURCE_URI = 'http://169.254.169.254/latest/meta-data/';
export const ALLOWED_OVERRIDES = [
  'MONGODB_URI',
  'MERA_SERVER_ASYNC_API_KEY',
  'FEED_FETCH_ALLOW_HOSTS',
];
const PUBLISHER_BASE = 'http://127.0.0.1:8765';
const BLOCK_TIMEOUT_MS = 10 * 60 * 1000;

// Matched on the whole line, character for character.
const SKIP = [
  [
    'git clone https://github.com/Mera-News/mera-news-data-server.git ~/mera-news-data-server',
    'the repository is already checked out (and ~/mera-news-data-server leads to it)',
  ],
  [
    'ollama pull nomic-embed-text',
    'Ollama is replaced by a fake embeddings server on the same address',
  ],
  [
    'docker run -d --restart unless-stopped --name news-redis -p 127.0.0.1:6379:6379 redis:7.2-alpine redis-server --maxmemory-policy noeviction',
    'CI provides Redis as a service',
  ],
  [
    'npm run seed-places -- --file cities15000.txt --admin1-file admin1CodesASCII.txt',
    'needs a GeoNames download',
  ],
].map(([text, reason]) => ({ text, reason }));

export function extractBlocks(md) {
  const blocks = [];
  let step = '';
  let open = null;
  md.split('\n').forEach((line, i) => {
    if (open) {
      if (/^```\s*$/.test(line)) {
        blocks.push({ ...open, text: open.lines.join('\n') });
        open = null;
      } else open.lines.push(line);
      return;
    }
    const heading = line.match(/^## (\d+)\./);
    if (heading) step = heading[1];
    const fenced = line.match(/^```(\w*)\s*$/);
    if (fenced) open = { lang: fenced[1], step, line: i + 1, lines: [] };
  });
  return blocks;
}

const skipFor = (line) => SKIP.find((s) => s.text === line);

export function planBlocks(blocks) {
  let envSeen = false;
  let feedsSeen = false;
  return blocks.map((block) => {
    const skipped =
      block.lang === 'sh'
        ? block.lines.flatMap((line) => {
            const s = skipFor(line);
            return s ? [{ line, reason: s.reason }] : [];
          })
        : [];
    let action = 'never';
    if (block.lang === 'sh') {
      action =
        skipped.length === block.lines.length
          ? 'skip'
          : block.lines[0] === '# in a new terminal'
            ? 'background'
            : 'run';
    } else if (block.lang === 'dotenv' && !envSeen) {
      envSeen = true;
      action = 'write-env';
    } else if (block.lang === 'json' && !feedsSeen) {
      feedsSeen = true;
      action = 'write-feeds';
    }
    return { block, action, skipped };
  });
}

export function blockScript(block) {
  return block.lines.filter((line) => !skipFor(line)).join('\n') + '\n';
}

const keysOf = (text) =>
  new Set([...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

export function lint(md, envExample) {
  const problems = [];
  const blocks = extractBlocks(md);
  for (const b of blocks.filter((x) => x.lang === 'sh')) {
    for (const m of b.text.matchAll(/<[A-Za-z][A-Za-z0-9_ -]*>/g)) {
      problems.push(
        `step ${b.step} (line ${b.line}): placeholder ${m[0]} in a sh block`,
      );
    }
  }
  const dotenv = blocks.find((b) => b.lang === 'dotenv');
  if (!dotenv) problems.push('the guide has no dotenv block');
  else {
    const guide = keysOf(dotenv.text);
    const example = keysOf(envExample);
    for (const k of guide)
      if (!example.has(k))
        problems.push(
          `${k} is in the guide's dotenv block but not in .env.example`,
        );
    for (const k of example)
      if (!guide.has(k))
        problems.push(
          `${k} is in .env.example but not in the guide's dotenv block`,
        );
  }
  return problems;
}

/**
 * Skip-list commands that no `sh` line of the guide matches any more. Each one
 * is a command the guide changed: left alone, the new text would run in CI.
 */
export function unusedSkips(md) {
  const lines = new Set(
    extractBlocks(md)
      .filter((b) => b.lang === 'sh')
      .flatMap((b) => b.text.split('\n')),
  );
  return SKIP.filter((s) => !lines.has(s.text)).map(
    (s) => `skip-list command not found in the guide: ${s.text}`,
  );
}

export function applyOverrides(dotenv, overrides) {
  let out = dotenv.endsWith('\n') ? dotenv : dotenv + '\n';
  for (const [key, value] of Object.entries(overrides)) {
    if (!ALLOWED_OVERRIDES.includes(key)) {
      throw new Error(
        `${key} may not be overridden: the runner changes only ${ALLOWED_OVERRIDES.join(', ')}`,
      );
    }
    if (!/^[\w.:/@?=,%+-]+$/.test(value))
      throw new Error(`the value for ${key} is not safe to source in a shell`);
    const line = new RegExp(`^${key}=.*$`, 'm');
    if (line.test(out)) out = out.replace(line, () => `${key}=${value}`);
    else if (key === 'FEED_FETCH_ALLOW_HOSTS') out += `${key}=${value}\n`;
    else
      throw new Error(
        `the guide's dotenv block has no ${key} line to override`,
      );
  }
  return out;
}

export function buildFeedsFile(
  guideFeeds,
  { feeds },
  { publisherBase, allowHosts },
) {
  const host = new URL(REFUSED_SOURCE_URI).hostname;
  if (allowHosts.split(',').some((e) => e === host || e === `${host}:80`)) {
    throw new Error(
      `the refused source ${REFUSED_SOURCE_URI} would be allowed by FEED_FETCH_ALLOW_HOSTS`,
    );
  }
  const file = structuredClone(guideFeeds);
  const unused = [...feeds];
  const uriOf = (feed) => `${publisherBase}/feeds/${feed.slug}.xml`;
  for (const publishers of Object.values(file)) {
    for (const publisher of publishers) {
      for (const feed of publisher.publication_rss_feed_uris) {
        const at = unused.findIndex((f) => f.language === feed.language_code);
        if (at < 0)
          throw new Error(
            `no fixture feed in language "${feed.language_code}" for ${feed.uri}`,
          );
        feed.uri = uriOf(unused.splice(at, 1)[0]);
      }
    }
  }
  const add = (country, name, site, uri, language) =>
    (file[country] ??= []).push({
      publication_name: name,
      publication_website_uri: site,
      publication_rss_feed_uris: [{ uri, language_code: language }],
    });
  for (const f of unused)
    add(
      f.country,
      f.publication_name,
      `https://${f.slug}.example.test`,
      uriOf(f),
      f.language,
    );
  add(
    'GBR',
    'Metadata Probe',
    'https://metadata-probe.example.test',
    REFUSED_SOURCE_URI,
    'en',
  );
  return file;
}

function describe(plans) {
  const lines = [];
  for (const { block, action, skipped } of plans) {
    const where = `step ${block.step || '-'}, line ${block.line}, ${block.lang || 'unlabelled'}`;
    const what = {
      run: 'run in the main terminal',
      background: 'run in a new terminal',
      skip: 'skip the whole block',
      'write-env': 'write .env (three settings overridden)',
      'write-feeds':
        'write my-feeds.json (fixture feeds, plus a source that must be refused)',
      never: 'never run',
    }[action];
    lines.push(`${where}: ${what}`);
    for (const s of skipped) lines.push(`    skip: ${s.line} (${s.reason})`);
  }
  return lines.join('\n');
}

function startShell(cwd) {
  const sh = spawn('bash', ['-euo', 'pipefail'], {
    cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  sh.stdin.write('exec 2>&1\n');
  return sh;
}

// One block at a time: the block is sourced in the persistent shell (so `cd`
// and exports carry over) and a marker follows it. A failing command ends the
// shell under `set -e`, which fails the block.
function runInShell(sh, file, n, quiet = false) {
  return new Promise((resolveBlock, reject) => {
    const marker = `__BLOCK_DONE_${n}__`;
    let pending = '';
    const timer = setTimeout(() => {
      sh.kill('SIGKILL');
      reject(new Error('timed out after 10 minutes'));
    }, BLOCK_TIMEOUT_MS);
    const onData = (chunk) => {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      const at = lines.findIndex((l) => l.includes(marker));
      for (const l of at < 0 ? lines : lines.slice(0, at))
        if (!quiet) console.log(l);
      if (at >= 0) done(resolveBlock);
    };
    const onExit = (code, signal) =>
      done(() => reject(new Error(`the shell exited with ${code ?? signal}`)));
    const done = (settle) => {
      clearTimeout(timer);
      sh.stdout.off('data', onData);
      sh.off('exit', onExit);
      settle();
    };
    sh.stdout.setEncoding('utf8');
    sh.stdout.on('data', onData);
    sh.once('exit', onExit);
    sh.stdin.write(`. '${file}' </dev/null\nprintf '\\n${marker}\\n'\n`);
  });
}

/**
 * The guide keeps the code in ~/mera-news-data-server and its new-terminal
 * blocks start with that `cd`. In CI that path is made to lead to this
 * checkout; outside CI it must already, and nothing in the home folder is made.
 */
function ensureHomeLink(md) {
  if (!md.includes('~/mera-news-data-server')) return;
  const link = join(homedir(), 'mera-news-data-server');
  const here = realpathSync(process.cwd());
  if (existsSync(link)) {
    if (realpathSync(link) !== here)
      throw new Error(`${link} exists and is not this checkout`);
    return;
  }
  if (!process.env.CI)
    throw new Error(
      `${link} does not exist: outside CI the runner makes nothing in the home folder`,
    );
  symlinkSync(here, link);
}

async function runGuide(plans) {
  const uri = process.env.MONGODB_URI ?? '';
  let database = '';
  try {
    database = new URL(uri).pathname;
  } catch {}
  if (database !== '/mera-news')
    throw new Error('MONGODB_URI must be set, and name the database mera-news');
  if (!process.env.CI && existsSync('.env'))
    throw new Error('.env exists: not overwriting it outside CI');
  // The guide's example database name is a real reader's too: outside CI the
  // run may only touch a database on this machine.
  if (
    !process.env.CI &&
    !['127.0.0.1', 'localhost'].includes(new URL(uri).hostname)
  )
    throw new Error(
      'outside CI, MONGODB_URI must point at 127.0.0.1 or localhost',
    );
  ensureHomeLink(readFileSync(process.argv[2], 'utf8'));

  const work = mkdtempSync(join(tmpdir(), 'selfhost-docs-'));
  const logDir = process.env.SELFHOST_LOG_DIR ?? work;
  mkdirSync(logDir, { recursive: true });
  const pids = join(logDir, 'background.pids');
  const sh = startShell(process.cwd());
  const background = [];
  const stopBackground = () =>
    background.forEach((pid) => {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {}
    });
  let n = 0;
  try {
    for (const { block, action, skipped } of plans) {
      const head = `\n=== step ${block.step || '-'}, line ${block.line}, ${block.lang}: ${action}`;
      if (action === 'never') {
        console.log(`${head} (never run)`);
        continue;
      }
      console.log(head);
      for (const s of skipped) console.log(`skip: ${s.line} (${s.reason})`);
      if (action === 'skip') continue;
      if (action === 'write-env') {
        const key = randomBytes(32).toString('hex');
        writeFileSync(
          '.env',
          applyOverrides(block.text, {
            MONGODB_URI: uri,
            MERA_SERVER_ASYNC_API_KEY: key,
            FEED_FETCH_ALLOW_HOSTS: new URL(PUBLISHER_BASE).host,
          }),
          { mode: 0o600 },
        );
        console.log(
          `overridden: MONGODB_URI (the CI database), MERA_SERVER_ASYNC_API_KEY (random), FEED_FETCH_ALLOW_HOSTS=${new URL(PUBLISHER_BASE).host}`,
        );
        continue;
      }
      if (action === 'write-feeds') {
        const stories = JSON.parse(
          readFileSync(
            new URL('fixtures/stories.json', import.meta.url),
            'utf8',
          ),
        );
        const file = buildFeedsFile(JSON.parse(block.text), stories, {
          publisherBase: PUBLISHER_BASE,
          allowHosts: new URL(PUBLISHER_BASE).host,
        });
        writeFileSync('my-feeds.json', JSON.stringify(file, null, 2) + '\n');
        console.log('wrote my-feeds.json');
        continue;
      }
      const script = join(work, `block-${++n}.sh`);
      writeFileSync(script, blockScript(block));
      if (action === 'run') {
        await runInShell(sh, script, n);
        continue;
      }
      // "in a new terminal": its own process, with the main shell's exported environment.
      const state = join(work, `state-${n}`);
      writeFileSync(
        `${script}.state`,
        `pwd > '${state}.cwd'\nenv -0 > '${state}.env'\n`,
      );
      await runInShell(sh, `${script}.state`, `${n}s`, true);
      const env = Object.fromEntries(
        readFileSync(`${state}.env`, 'utf8')
          .split('\0')
          .filter(Boolean)
          .map((kv) => [
            kv.slice(0, kv.indexOf('=')),
            kv.slice(kv.indexOf('=') + 1),
          ]),
      );
      const log = join(logDir, `background-${n}.log`);
      const fd = openSync(log, 'w');
      const child = spawn('bash', ['-euo', 'pipefail', script], {
        cwd: readFileSync(`${state}.cwd`, 'utf8').trim(),
        env,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      child.unref();
      background.push(child.pid);
      appendFileSync(pids, `${child.pid}\n`);
      console.log(`started in the background, log ${log}`);
    }
  } catch (error) {
    stopBackground();
    sh.kill('SIGKILL');
    throw error;
  }
  sh.stdin.end();
  console.log(
    `\nguide followed to the end; background processes left running (pids in ${pids})`,
  );
}

async function main(argv) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const [guide] = argv.filter((a) => !a.startsWith('--'));
  const unknown = flags.filter((f) => !['--lint', '--dry-run'].includes(f));
  if (!guide || unknown.length)
    throw new Error('usage: run-docs.mjs <guide.md> [--lint | --dry-run]');
  const md = readFileSync(guide, 'utf8');
  const problems = [
    ...lint(
      md,
      readFileSync(resolve(dirname(guide), '..', '.env.example'), 'utf8'),
    ),
    // Only for --lint: a test guide holds none of the skipped commands.
    ...(flags.includes('--lint') ? unusedSkips(md) : []),
  ];
  const plans = planBlocks(extractBlocks(md));
  if (flags.includes('--lint')) {
    problems.forEach((p) => console.log(`problem: ${p}`));
    console.log(problems.length ? `${problems.length} problem(s)` : 'lint ok');
    return problems.length ? 1 : 0;
  }
  if (flags.includes('--dry-run')) {
    console.log(describe(plans));
    return 0;
  }
  if (problems.length) {
    problems.forEach((p) => console.log(`problem: ${p}`));
    return 1;
  }
  await runGuide(plans);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`FAILED: ${error.message}`);
      process.exit(1);
    },
  );
}
