import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_OVERRIDES,
  applyOverrides,
  blockScript,
  buildFeedsFile,
  extractBlocks,
  lint,
  planBlocks,
  REFUSED_SOURCE_URI,
  unusedSkips,
} from './run-docs.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const guidePath = new URL('../../../docs/self-host.md', import.meta.url);
const envExamplePath = new URL('../../../.env.example', import.meta.url);
const stories = JSON.parse(
  readFileSync(new URL('fixtures/stories.json', import.meta.url), 'utf8'),
);
const fence = (lang, body) => '```' + lang + '\n' + body + '\n```';
const guideOf = (...blocks) => blocks.join('\n\n');
const plan = (md) => planBlocks(extractBlocks(md));

test('extracts fenced blocks in order, with the step number they sit under', () => {
  const md = `## 3. Get\n\n${fence('sh', 'echo a')}\n\n## 4. Next\n\n${fence('json', '{}')}`;
  const blocks = extractBlocks(md);
  assert.deepEqual(
    blocks.map((b) => [b.lang, b.step, b.text]),
    [
      ['sh', '3', 'echo a'],
      ['json', '4', '{}'],
    ],
  );
});

test('a sh block runs; a block opened with "# in a new terminal" runs in the background', () => {
  const [run, bg] = plan(
    guideOf(
      fence('sh', 'npm run build'),
      fence('sh', '# in a new terminal\nnode server.js'),
    ),
  );
  assert.equal(run.action, 'run');
  assert.equal(bg.action, 'background');
});

test('dotenv, json, ini and javascript blocks never run; only the first dotenv and json are written', () => {
  const actions = plan(
    guideOf(
      fence('dotenv', 'MONGODB_URI=x'),
      fence('dotenv', 'OTHER=1'),
      fence('json', '{}'),
      fence('json', '{}'),
      fence('ini', '[Unit]'),
      fence('javascript', 'db.x()'),
    ),
  ).map((p) => p.action);
  assert.deepEqual(actions, [
    'write-env',
    'never',
    'write-feeds',
    'never',
    'never',
    'never',
  ]);
});

test('the skip list matches exact command text and keeps every other line verbatim', () => {
  const [step3] = plan(
    fence(
      'sh',
      'git clone https://github.com/Mera-News/mera-news-data-server.git ~/mera-news-data-server\ncd ~/mera-news-data-server\nnpm ci\nnpm run build:async',
    ),
  );
  assert.equal(step3.action, 'run');
  assert.equal(step3.skipped.length, 1);
  assert.equal(
    blockScript(step3.block),
    'cd ~/mera-news-data-server\nnpm ci\nnpm run build:async\n',
  );
});

test('a changed command is not skipped, so it runs and fails where the guide changed', () => {
  for (const changed of [
    'ollama pull nomic-embed-text:latest',
    'ollama pull  nomic-embed-text',
    'ollama pull nomic-embed-text ',
    'ollama pull nomic-embed-text2',
    'git clone https://github.com/Mera-News/mera-news-data-server.git',
  ]) {
    const [p] = plan(fence('sh', changed));
    assert.equal(p.action, 'run', changed);
    assert.deepEqual(p.skipped, [], changed);
    assert.equal(blockScript(p.block), changed + '\n', changed);
  }
});

test('lint names a skip-list command the guide no longer contains', () => {
  const md = fence('sh', 'ollama pull nomic-embed-text');
  const missing = unusedSkips(md);
  assert.ok(missing.some((p) => p.includes('docker run')));
  assert.ok(!missing.some((p) => p.includes('ollama pull')));
});

test('every skip-list command still matches a line of the real guide', () => {
  assert.deepEqual(unusedSkips(readFileSync(guidePath, 'utf8')), []);
});

test('a block made only of skipped commands is skipped as a whole', () => {
  const [p] = plan(fence('sh', 'ollama pull nomic-embed-text'));
  assert.equal(p.action, 'skip');
  assert.match(p.skipped[0].reason, /ollama/i);
});

test('lint fails on a <placeholder> inside a sh block only', () => {
  const env = 'A=1\n';
  const bad = guideOf(fence('dotenv', 'A=1'), fence('sh', 'cp <file> here'));
  assert.match(lint(bad, env).join('\n'), /<file>/);
  const ok = guideOf(fence('dotenv', 'A=1'), fence('json', '{"x": "<file>"}'));
  assert.deepEqual(lint(ok, env), []);
});

test('lint fails when the dotenv keys and .env.example differ, in either direction', () => {
  const md = fence('dotenv', '# c\nA=1\nB=2');
  assert.deepEqual(lint(md, '# c\nA=\nB=\n'), []);
  assert.match(lint(md, 'A=\n').join('\n'), /B/);
  assert.match(lint(md, 'A=\nB=\nC=\n').join('\n'), /C/);
});

test('only three settings may be overridden, and every other line stays as written', () => {
  const dotenv =
    'MONGODB_URI=a\nMERA_SERVER_ASYNC_API_KEY=b\nEMBEDDING_DIMS=768\n';
  const out = applyOverrides(dotenv, {
    MONGODB_URI: 'mongodb://127.0.0.1/mera-news',
    MERA_SERVER_ASYNC_API_KEY: 'k',
    FEED_FETCH_ALLOW_HOSTS: '127.0.0.1:8765',
  });
  assert.equal(
    out,
    'MONGODB_URI=mongodb://127.0.0.1/mera-news\nMERA_SERVER_ASYNC_API_KEY=k\nEMBEDDING_DIMS=768\nFEED_FETCH_ALLOW_HOSTS=127.0.0.1:8765\n',
  );
  assert.equal(ALLOWED_OVERRIDES.length, 3);
});

test('a fourth setting is refused', () => {
  assert.throws(
    () => applyOverrides('EMBEDDING_DIMS=768\n', { EMBEDDING_DIMS: '1024' }),
    /EMBEDDING_DIMS/,
  );
  assert.throws(
    () => applyOverrides('A=1\n', { TRANSLATION_PROVIDER: 'fake' }),
    /TRANSLATION_PROVIDER/,
  );
});

test('an override value must be safe to source in a shell', () => {
  assert.throws(
    () => applyOverrides('MONGODB_URI=a\n', { MONGODB_URI: 'a b;rm -rf x' }),
    /MONGODB_URI/,
  );
});

const guideFeeds = {
  GBR: [
    {
      publication_name: 'Example Daily',
      publication_website_uri: 'https://example-daily.example.com',
      publication_rss_feed_uris: [
        {
          uri: 'https://example-daily.example.com/rss.xml',
          language_code: 'en',
        },
      ],
    },
  ],
  FRA: [
    {
      publication_name: 'Exemple Quotidien',
      publication_website_uri: 'https://exemple-quotidien.example.com',
      publication_rss_feed_uris: [
        {
          uri: 'https://exemple-quotidien.example.com/feed',
          language_code: 'fr',
        },
      ],
    },
  ],
};
const feedUris = (file) =>
  Object.values(file).flatMap((pubs) =>
    pubs.flatMap((p) => p.publication_rss_feed_uris.map((f) => f.uri)),
  );
const options = {
  publisherBase: 'http://127.0.0.1:8765',
  allowHosts: '127.0.0.1:8765',
};

test('the feed file has the five fixture feeds and a sixth, refused source', () => {
  const uris = feedUris(buildFeedsFile(guideFeeds, stories, options));
  assert.equal(uris.length, 6);
  assert.equal(
    uris.filter((u) => u.startsWith('http://127.0.0.1:8765/')).length,
    5,
  );
  assert.deepEqual(
    uris.filter((u) => u === REFUSED_SOURCE_URI),
    [REFUSED_SOURCE_URI],
  );
  assert.equal(REFUSED_SOURCE_URI, 'http://169.254.169.254/latest/meta-data/');
});

test('the guide feeds keep their names and take the fixture address of the same language', () => {
  const file = buildFeedsFile(guideFeeds, stories, options);
  assert.equal(file.GBR[0].publication_name, 'Example Daily');
  assert.match(
    file.GBR[0].publication_rss_feed_uris[0].uri,
    /^http:\/\/127\.0\.0\.1:8765\//,
  );
  assert.equal(file.FRA[0].publication_rss_feed_uris[0].language_code, 'fr');
});

test('the sixth source is not built when its host would be allowed', () => {
  assert.throws(
    () =>
      buildFeedsFile(guideFeeds, stories, {
        ...options,
        allowHosts: '169.254.169.254:80,127.0.0.1:8765',
      }),
    /refused/,
  );
  assert.throws(
    () =>
      buildFeedsFile(guideFeeds, stories, {
        ...options,
        allowHosts: '169.254.169.254',
      }),
    /refused/,
  );
});

test('a guide feed in a language the fixtures lack stops the build', () => {
  const odd = structuredClone(guideFeeds);
  odd.GBR[0].publication_rss_feed_uris[0].language_code = 'de';
  assert.throws(() => buildFeedsFile(odd, stories, options), /language/);
});

const sha = (url) =>
  createHash('sha256').update(readFileSync(url)).digest('hex');
const cli = (...args) =>
  spawnSync('node', [`${here}run-docs.mjs`, ...args], {
    cwd: fileURLToPath(new URL('../../../', import.meta.url)),
    encoding: 'utf8',
  });

test('--lint and --dry-run pass on the guide and leave it unchanged', () => {
  const before = [sha(guidePath), sha(envExamplePath)];
  const lintRun = cli('--lint', 'docs/self-host.md');
  assert.equal(lintRun.status, 0, lintRun.stdout + lintRun.stderr);
  const dry = cli('--dry-run', 'docs/self-host.md');
  assert.equal(dry.status, 0, dry.stdout + dry.stderr);
  for (const text of [
    'ollama pull nomic-embed-text',
    'git clone https://github.com/Mera-News/mera-news-data-server.git ~/mera-news-data-server',
    'docker run -d --restart unless-stopped',
    'seed-places',
    'in a new terminal',
    'never run',
  ]) {
    assert.ok(dry.stdout.includes(text), `dry-run output lacks "${text}"`);
  }
  assert.deepEqual([sha(guidePath), sha(envExamplePath)], before);
});

function followGuide(blocks) {
  const dir = mkdtempSync(join(tmpdir(), 'follow-'));
  mkdirSync(join(dir, 'docs'));
  mkdirSync(join(dir, 'logs'));
  const dotenv = fence('dotenv', 'MONGODB_URI=x\nMERA_SERVER_ASYNC_API_KEY=y');
  writeFileSync(join(dir, 'docs/g.md'), guideOf(dotenv, ...blocks));
  writeFileSync(
    join(dir, '.env.example'),
    'MONGODB_URI=\nMERA_SERVER_ASYNC_API_KEY=\n',
  );
  const run = spawnSync('node', [`${here}run-docs.mjs`, 'docs/g.md'], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      MONGODB_URI: 'mongodb://127.0.0.1/mera-news',
      SELFHOST_LOG_DIR: join(dir, 'logs'),
    },
  });
  const pids = existsSync(join(dir, 'logs/background.pids'))
    ? readFileSync(join(dir, 'logs/background.pids'), 'utf8')
        .split('\n')
        .filter(Boolean)
    : [];
  for (const pid of pids)
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {}
  return { run, dir };
}

test('blocks share one shell, a new-terminal block inherits its exports, and a failing command stops the run', () => {
  const ok = followGuide([
    fence('sh', 'mkdir sub\ncd sub\nexport GREETING=hello'),
    fence(
      'sh',
      '# in a new terminal\necho "$GREETING from $(basename "$PWD")" > ../seen.txt',
    ),
    fence(
      'sh',
      'until [ -s ../seen.txt ]; do sleep 0.1; done\ncat ../seen.txt',
    ),
  ]);
  assert.equal(ok.run.status, 0, ok.run.stdout + ok.run.stderr);
  assert.match(ok.run.stdout, /hello from sub/);
  const bad = followGuide([fence('sh', 'false'), fence('sh', 'echo reached')]);
  assert.equal(bad.run.status, 1);
  assert.doesNotMatch(bad.run.stdout, /reached/);
});
