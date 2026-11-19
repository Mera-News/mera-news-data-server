import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startFakeEmbeddings } from './fake-embeddings.mjs';
import { startFixturePublisher } from './fixture-publisher.mjs';

let embeddings;
let publisher;
before(async () => {
  embeddings = await startFakeEmbeddings({ port: 0 });
  publisher = await startFixturePublisher({ port: 0 });
});
after(async () => {
  await Promise.all([embeddings.close(), publisher.close()]);
});

const embed = async (input, model = 'nomic-embed-text') => {
  const res = await fetch(`http://127.0.0.1:${embeddings.port}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });
  return { status: res.status, body: await res.json() };
};
const cosine = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

test('answers { data: [{ index, embedding }] } with 768 unit-length values', async () => {
  const { status, body } = await embed(['a', 'b', 'c']);
  assert.equal(status, 200);
  assert.deepEqual(
    body.data.map((d) => d.index),
    [0, 1, 2],
  );
  for (const d of body.data) {
    assert.equal(d.embedding.length, 768);
    assert.ok(Math.abs(Math.hypot(...d.embedding) - 1) < 1e-6);
  }
});

test('texts about one story are about 0.99 related, other texts about 0.5', async () => {
  const { body } = await embed([
    'electric buses',
    'Brightwater orders 40 electric buses for its city routes',
    'Brightwater commande quarante bus électriques',
    'qwxz plorb',
    'Halvorsen Bridge reopens',
  ]);
  const [topic, en, fr, gibberish, bridge] = body.data.map((d) => d.embedding);
  assert.ok(cosine(topic, en) > 0.97 && cosine(topic, fr) > 0.97);
  assert.ok(cosine(topic, gibberish) < 0.2);
  assert.ok(cosine(topic, bridge) < 0.2);
});

test('lone items point away from every story and each other, whatever text surrounds the keyword', async () => {
  const { body } = await embed([
    'Tidewick Lighthouse reopens',
    'Tidewick Lighthouse reopens to visitors\nCountry: GBR\nCategory: Travel',
    'El Festival de Marmolar abre su programa',
    'Brightwater orders 40 electric buses',
    'Halvorsen Bridge reopens',
    'Kestrel Orbital test flight',
  ]);
  const [a, a2, b, ...stories] = body.data.map((d) => d.embedding);
  assert.deepEqual(a, a2);
  assert.ok(cosine(a, b) < -0.5);
  for (const s of stories) {
    assert.ok(cosine(a, s) < -0.2 && cosine(b, s) < -0.2);
  }
});

test('the same text always gets the same vector', async () => {
  const a = (await embed('qwxz plorb')).body.data[0].embedding;
  const b = (await embed(['qwxz plorb'])).body.data[0].embedding;
  assert.deepEqual(a, b);
});

test('another model name or a body without input is refused', async () => {
  assert.equal((await embed('x', 'jina')).status, 404);
  assert.equal((await embed(undefined)).status, 400);
});

const feed = async (slug) =>
  (await fetch(`http://127.0.0.1:${publisher.port}/feeds/${slug}.xml`)).text();

test('serves five feeds with dated items and https links on example.test', async () => {
  let items = 0;
  for (const slug of [
    'harbour-gazette',
    'northern-ledger',
    'le-courrier-du-port',
    'el-diario-del-valle',
    'daily-lantern',
  ]) {
    const xml = await feed(slug);
    for (const m of xml.matchAll(/<item>[\s\S]*?<\/item>/g)) {
      items++;
      const date = Date.parse(m[0].match(/<pubDate>(.*?)<\/pubDate>/)[1]);
      assert.ok(Date.now() - date < 48 * 3600 * 1000 && date <= Date.now());
      assert.match(m[0], /<link>https:\/\/[a-z0-9-]+\.example\.test\//);
    }
  }
  assert.equal(items, 11);
});

test('every request path is recorded, and an unknown feed is a 404', async () => {
  const res = await fetch(
    `http://127.0.0.1:${publisher.port}/latest/meta-data/`,
  );
  assert.equal(res.status, 404);
  const seen = await (
    await fetch(`http://127.0.0.1:${publisher.port}/__hits`)
  ).json();
  assert.ok(seen.includes('/latest/meta-data/'));
  assert.ok(seen.includes('/feeds/daily-lantern.xml'));
});

test('the near-line feed has items just under and just over 140 bytes', async () => {
  const sizes = [
    ...(await feed('daily-lantern')).matchAll(
      /<description>(.*?)<\/description>/g,
    ),
  ]
    .map((m) => Buffer.byteLength(m[1]))
    .filter((n) => n > 100);
  assert.ok(sizes.some((n) => n >= 135 && n < 140));
  assert.ok(sizes.some((n) => n > 140 && n <= 145));
});
