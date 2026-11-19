#!/usr/bin/env node
// Boot each BUILT service against unreachable fake backends and fail if it dies
// while loading modules rather than on config or connectivity.
//
// Why: Nest 12 and several deps ship as ESM and load through Node's require(esm).
// Jest transforms hide that whole failure class (ERR_REQUIRE_ESM,
// ERR_REQUIRE_ASYNC_MODULE, a missing optional peer such as ioredis), so only
// the real bundle under plain node can show it.
//
// Usage: npm run build:<each service> first, then `npm run boot-smoke`.
// Runs from a temp cwd with every backend URL forced to 127.0.0.1:9, so no
// `apps/*/.env` is read and nothing real is ever reached.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(process.env.BOOT_SMOKE_ROOT ?? resolve(import.meta.dirname, '../..'));
const args = process.argv.slice(2);
const SERVICES = args.length ? args : ['mera-server-async', 'mera-server-news-api'];
const LOAD_FAILURES = [
  'ERR_REQUIRE_ESM',
  'ERR_REQUIRE_ASYNC_MODULE',
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'Cannot find module',
  'could not load the optional',
  'does not provide an export named',
  'SyntaxError',
];
const RUN_MS = 20_000;
const cwd = mkdtempSync(join(tmpdir(), 'boot-smoke-'));
const dead = 'mongodb://127.0.0.1:9/boot-smoke?serverSelectionTimeoutMS=1500';
const env = {
  PATH: process.env.PATH,
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  PORT: '0',
  MONGODB_URI: dead,
  REDIS_URL: 'redis://127.0.0.1:9',
  PERSISTENT_REDIS_URL: 'redis://127.0.0.1:9',
  ...JSON.parse(process.env.BOOT_SMOKE_EXTRA_ENV ?? '{}'),
};

const findLoadFailure = (text) => LOAD_FAILURES.find((s) => text.includes(s));
let failed = false;

// Phase 1: every runtime dependency must load under plain require().
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies).filter(
  (name) => !name.startsWith('@types/') && name !== '@nestjs/cli',
);
const probe = spawnSync(
  process.execPath,
  [
    '-e',
    `for (const p of ${JSON.stringify(deps)}) { try { require(p) } catch (e) { console.log('FAIL', p, e.code || '', String(e.message).split('\\n')[0]) } }`,
  ],
  { cwd: repo, encoding: 'utf8', env },
);
const depFailures = (probe.stdout + probe.stderr)
  .split('\n')
  .filter((line) => line.startsWith('FAIL'));
if (depFailures.length) {
  failed = true;
  console.log(depFailures.join('\n'));
} else {
  console.log(`deps: ${deps.length} runtime packages load under require()`);
}

// Phase 2: each built bundle starts and fails on config or connectivity only.
for (const service of SERVICES) {
  const main = join(repo, 'dist/apps', service, 'main.js');
  if (!existsSync(main)) {
    failed = true;
    console.log(`${service}: MISSING ${main} (build it first)`);
    continue;
  }
  const result = await new Promise((done) => {
    let out = '';
    const child = spawn(process.execPath, [main], { cwd, env });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      done({ code, signal, out });
    });
  });
  const failure = findLoadFailure(result.out);
  const how = result.signal ? 'still running, killed' : `exit ${result.code}`;
  if (failure) {
    failed = true;
    const line = result.out.split('\n').find((l) => l.includes(failure));
    console.log(`${service}: LOAD FAILURE (${how}): ${line?.trim()}`);
  } else {
    const last = result.out.trim().split('\n').filter(Boolean).at(-1) ?? '';
    console.log(`${service}: ok (${how}, no module-load error) last: ${last.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 140)}`);
  }
}

// Phase 3: the built news API in open mode answers without a key. It needs a
// reachable database to start (the open-mode warning prints after Mongo
// connects), so this one case runs against an in-memory mongod.
if (SERVICES.includes('mera-server-news-api') && !failed) {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const { createServer } = await import('node:net');
  const mongo = await MongoMemoryServer.create({ binary: { version: '8.2.6' } });
  const port = await new Promise((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => done(free));
    });
  });
  let out = '';
  const child = spawn(process.execPath, [join(repo, 'dist/apps/mera-server-news-api/main.js')], {
    cwd,
    env: {
      ...env,
      MONGODB_URI: mongo.getUri('boot-smoke'),
      NEWS_API_OPEN: 'true',
      MERA_NEWS_API_KEY: '',
      NEWS_API_HOST: '127.0.0.1',
      PORT: String(port),
      EMBEDDING_PROVIDER: 'fake',
      ALLOW_FAKE_PROVIDERS: 'true',
    },
  });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  let answer;
  for (let i = 0; i < 60 && !answer; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ allCountries }' }),
      });
      answer = { status: res.status, body: await res.json() };
    } catch {
      // not listening yet
    }
  }
  child.kill('SIGKILL');
  await mongo.stop();
  const warnings = out.split('NEWS_API_OPEN=true: the news API answers without a key').length - 1;
  const refused = JSON.stringify(answer?.body ?? {}).includes('UNAUTHENTICATED');
  if (!answer || answer.status !== 200 || refused || warnings !== 1) {
    failed = true;
    console.log(
      `mera-server-news-api open mode: FAILED (answer ${answer ? answer.status : 'none'}, refused ${refused}, warnings ${warnings})`,
    );
  } else {
    console.log('mera-server-news-api open mode: ok (answers without a key, warned once)');
  }
}

// Phase 4: the built worker takes its settings from the .env in the folder it
// starts in (nothing in its environment), and ASYNC_HOST=127.0.0.1 keeps it off
// every other address.
if (SERVICES.includes('mera-server-async') && !failed) {
  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const { createServer, connect } = await import('node:net');
  const { networkInterfaces } = await import('node:os');
  const { writeFileSync, mkdtempSync: mkdtemp } = await import('node:fs');
  const mongo = await MongoMemoryServer.create({ binary: { version: '8.2.6' } });
  const port = await new Promise((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => done(free));
    });
  });
  const home = mkdtemp(join(tmpdir(), 'boot-smoke-env-'));
  writeFileSync(
    join(home, '.env'),
    [
      `MONGODB_URI=${mongo.getUri('boot-smoke')}`,
      'REDIS_URL=redis://127.0.0.1:9',
      'MERA_SERVER_ASYNC_API_KEY=boot-smoke',
      'ASYNC_HOST=127.0.0.1',
      `ASYNC_PORT=${port}`,
      'EMBEDDING_PROVIDER=fake',
      'TRANSLATION_PROVIDER=fake',
      'ALLOW_FAKE_PROVIDERS=true',
      'NODE_ENV=production',
    ].join('\n'),
  );
  let out = '';
  const child = spawn(process.execPath, [join(repo, 'dist/apps/mera-server-async/main.js')], {
    cwd: home,
    env: { PATH: process.env.PATH },
  });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  let status;
  for (let i = 0; i < 60 && !status; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      status = (await fetch(`http://127.0.0.1:${port}/health`)).status;
    } catch {
      // not listening yet
    }
  }
  const outside = Object.values(networkInterfaces())
    .flat()
    .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  const reachedOutside = outside
    ? await new Promise((done) => {
        const socket = connect({ host: outside, port }, () => {
          socket.destroy();
          done(true);
        });
        socket.on('error', () => done(false));
      })
    : false;
  child.kill('SIGKILL');
  await mongo.stop();
  if (status !== 200 || reachedOutside) {
    failed = true;
    console.log(
      `mera-server-async root .env and ASYNC_HOST: FAILED (health ${status ?? 'none'}, reachable on ${outside}: ${reachedOutside})`,
    );
    console.log(out.split('\n').slice(-5).join('\n'));
  } else {
    console.log(
      `mera-server-async root .env and ASYNC_HOST: ok (settings from ./.env only; 127.0.0.1 answers${outside ? `, ${outside} refused` : ''})`,
    );
  }
}

process.exit(failed ? 1 : 0);
