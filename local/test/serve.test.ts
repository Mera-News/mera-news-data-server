import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createFakeEmbedder } from '../src/embed/fake.ts';
import { MAX_REQUEST_BYTES, startServer, type RunningServer } from '../src/serve/http.ts';
import { runServe } from '../src/serve/run.ts';
import { Store } from '../src/store/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'mera-news-local-serve-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const embedder = createFakeEmbedder(8);
let store: Store;
let server: RunningServer;

before(async () => {
  store = new Store(join(dir, 'news.db'));
  store.assertEmbeddingModel({ id: embedder.model, dims: embedder.dims });
  server = await startServer({ store, embedder }, 0);
});
after(async () => {
  await server.close();
  store.close();
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(options: { method?: string; path?: string; host?: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        method: options.method ?? 'POST',
        path: options.path ?? '/graphql',
        headers: { host: options.host ?? `127.0.0.1:${server.port}`, 'content-type': 'application/json', ...options.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body ?? JSON.stringify({ query: '{ allCountries }' }));
  });
}

describe('the local GraphQL endpoint', () => {
  it('listens on 127.0.0.1 only', () => {
    assert.equal((server.server.address() as AddressInfo).address, '127.0.0.1');
  });

  it('answers a plain POST from this machine, by address or by localhost, with no CORS headers', async () => {
    for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`]) {
      const reply = await send({ host });
      assert.equal(reply.status, 200);
      assert.deepEqual(JSON.parse(reply.body), { data: { allCountries: [] } });
      assert.equal(Object.keys(reply.headers).some((h) => h.startsWith('access-control-')), false);
    }
  });

  it('refuses another Host, as a page on a rebinding domain would send', async () => {
    const reply = await send({ host: `evil.example.test:${server.port}` });
    assert.equal(reply.status, 403);
    assert.equal((await send({ host: `127.0.0.1:${server.port + 1}` })).status, 403);
  });

  it('refuses any request that carries an Origin', async () => {
    assert.equal((await send({ headers: { origin: 'https://evil.example.test' } })).status, 403);
    assert.equal((await send({ headers: { origin: 'null' } })).status, 403);
  });

  it('takes GraphQL only as a JSON POST', async () => {
    assert.equal((await send({ method: 'GET', path: '/graphql?query=%7BallCountries%7D' })).status, 405);
    assert.equal((await send({ headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await send({ headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
    assert.equal((await send({ body: 'not json' })).status, 400);
  });

  it('refuses a body over the limit', async () => {
    assert.equal((await send({ body: JSON.stringify({ query: `{ allCountries } #${'x'.repeat(MAX_REQUEST_BYTES)}` }) })).status, 413);
  });

  it('answers introspection, which a pod uses to check the schema', async () => {
    const reply = await send({ body: JSON.stringify({ query: '{ __schema { queryType { name } } }' }) });
    assert.deepEqual(JSON.parse(reply.body).data, { __schema: { queryType: { name: 'Query' } } });
  });

  it('refuses a query deeper than the full server allows', async () => {
    const deep = `{ __schema { types { fields { type { ofType { ofType { ofType { ofType { ofType { ofType { ofType { ofType { name } } } } } } } } } } } } }`;
    const reply = await send({ body: JSON.stringify({ query: deep.replace('__schema', 'articlesForCountry').replace('types', 'articles { publicationSource') + ' }' }) });
    assert.equal(reply.status, 400);
  });

  it('answers health on GET, with the same Host and Origin checks', async () => {
    assert.equal((await send({ method: 'GET', path: '/health/ready' })).status, 200);
    assert.equal((await send({ method: 'GET', path: '/health/ready', headers: { origin: 'https://evil.example.test' } })).status, 403);
  });
});

describe('serve', () => {
  it('runs an ingest at start and again after the interval, and stops cleanly', async () => {
    const own = new Store(join(dir, 'serve.db'));
    let runs = 0;
    let stop!: () => void;
    const until = new Promise<void>((resolve) => (stop = resolve));
    const events: Record<string, unknown>[] = [];
    const done = runServe({
      store: own,
      embedder,
      port: 0,
      every: 0.001,
      ingest: async () => {
        runs++;
        if (runs === 2) stop();
      },
      onEvent: (e) => events.push(e),
      until,
    });
    await done;
    assert.ok(runs >= 2);
    assert.deepEqual(events.map((e) => e.event).filter((e) => e !== 'ingest_error'), ['serve_start', 'serve_stop']);
    own.close();
  });
});
