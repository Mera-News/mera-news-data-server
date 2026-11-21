import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EmbedError } from '../src/embed/embedder.ts';
import { createFakeEmbedder } from '../src/embed/fake.ts';
import { createOpenAiCompatibleEmbedder } from '../src/embed/openai-compatible.ts';
import { DEFAULT_MODEL, KNOWN_LICENCES, MODELS, NON_COMMERCIAL_LICENCES, OPEN_ALTERNATIVE_MODEL, licenceNotice } from '../src/embed/models.ts';
import { createLocalEmbedder, ensureModel } from '../src/embed/local.ts';

const norm = (v: Float32Array) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

test('fake embedder is deterministic and of length 1', async () => {
  const e = createFakeEmbedder(384);
  const [a, b, c] = await e.embedPassages(['one', 'one', 'two']);
  assert.equal(a!.length, 384);
  assert.ok(Math.abs(norm(a!) - 1) < 1e-5);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.deepEqual(await e.embedQuery('one'), a);
});

const KEY = 'sk-secret-123';
type Call = { url: string; headers: Record<string, string>; body: { model: string; input: string[] } };

function fakeFetch(opts: { dims?: number; drop?: boolean; status?: number } = {}) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    if (opts.status) return new Response(`denied ${KEY}`, { status: opts.status });
    const input: string[] = opts.drop ? body.input.slice(1) : body.input;
    // The vector encodes the input text length so order is checkable.
    const data = input.map((t, index) => ({ index, embedding: Array.from({ length: opts.dims ?? 4 }, (_, i) => (i === 0 ? t.length : 1)) }));
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const make = (f: typeof fetch, extra = {}) =>
  createOpenAiCompatibleEmbedder({ baseUrl: 'http://x/v1/', model: 'm', dims: 4, apiKey: KEY, fetch: f, batchSize: 2, ...extra });

test('openai-compatible batches in order and normalizes', async () => {
  const { fn, calls } = fakeFetch();
  const out = await make(fn).embedPassages(['a', 'bb', 'ccc', 'dddd', 'eeeee']);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.url, 'http://x/v1/embeddings');
  assert.deepEqual(calls.flatMap((c) => c.body.input), ['a', 'bb', 'ccc', 'dddd', 'eeeee']);
  assert.deepEqual(out.map((v) => Math.sign(v[0]!)), [1, 1, 1, 1, 1]);
  assert.ok(out[0]![0]! < out[4]![0]!, 'longer text carries more weight in dim 0, so order is kept');
  for (const v of out) assert.ok(Math.abs(norm(v) - 1) < 1e-5);
});

test('openai-compatible refuses a wrong vector size and a wrong count', async () => {
  await assert.rejects(make(fakeFetch({ dims: 3 }).fn).embedQuery('a'), (e: any) => e.code === 'embed_dims_mismatch' && /4/.test(e.message) && /3/.test(e.message));
  await assert.rejects(make(fakeFetch({ drop: true }).fn).embedPassages(['a', 'b']), (e: any) => e.code === 'embed_bad_response' && /2/.test(e.message) && /1/.test(e.message));
});

test('openai-compatible keeps the key out of errors and sends it only as a header', async () => {
  await assert.rejects(make(fakeFetch({ status: 401 }).fn).embedQuery('a'), (e: any) => e.code === 'embed_endpoint_failed' && !JSON.stringify([e.message, e.fix, e.stack]).includes(KEY));
  const { fn, calls } = fakeFetch();
  await make(fn).embedQuery('a');
  assert.equal(calls[0]!.headers.authorization, `Bearer ${KEY}`);
  assert.ok(!JSON.stringify(calls[0]!.body).includes(KEY));
  assert.ok(!calls[0]!.url.includes(KEY));
});

test('registry: every model states its licence, non-commercial ones are flagged, revisions are pinned', () => {
  assert.ok(MODELS[DEFAULT_MODEL]);
  assert.equal(MODELS[OPEN_ALTERNATIVE_MODEL]!.nonCommercial, false);
  for (const m of Object.values(MODELS)) {
    assert.ok(KNOWN_LICENCES.includes(m.licence), `${m.id} licence ${m.licence}`);
    assert.equal(m.nonCommercial, NON_COMMERCIAL_LICENCES.includes(m.licence), `${m.id} flag`);
    assert.match(m.revision, /^[0-9a-f]{40}$/, `${m.id} revision`);
    assert.doesNotMatch(m.hubId, /gemma/i);
    if (m.nonCommercial) assert.match(licenceNotice(m.id)!, new RegExp(`non-commercial.*config set embedder.model ${OPEN_ALTERNATIVE_MODEL}`));
    else assert.equal(licenceNotice(m.id), null);
  }
});

test('local embedder gives vectors of length 1', { skip: process.env.LOCAL_EMBED_TEST !== '1' }, async () => {
  const e = await createLocalEmbedder({ model: DEFAULT_MODEL, cacheDir: process.env.LOCAL_EMBED_CACHE ?? mkdtempSync(join(tmpdir(), 'embed-')) });
  const [v] = await e.embedPassages(['Rain floods the city']);
  assert.equal(v!.length, e.dims);
  assert.ok(Math.abs(norm(v!) - 1) < 1e-4);
});

describe('model files on a failed load', () => {
  const setup = () => {
    const cacheDir = mkdtempSync(join(tmpdir(), 'embed-cache-'));
    const kept = join(cacheDir, MODELS[DEFAULT_MODEL]!.hubId, 'tokenizer.json');
    mkdirSync(dirname(kept), { recursive: true });
    writeFileSync(kept, '{}');
    return { cacheDir, kept };
  };
  const failing = (...errors: unknown[]) => {
    let calls = 0;
    return { calls: () => calls, library: { env: {}, pipeline: async () => { const e = errors[Math.min(calls++, errors.length - 1)]; if (e) throw e; return async () => ({ data: new Float32Array(0) }); } } };
  };

  test('a network failure keeps every downloaded file and asks to resume', async () => {
    const { cacheDir, kept } = setup();
    const lib = failing(new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) }));
    await assert.rejects(ensureModel({ model: DEFAULT_MODEL, cacheDir, library: lib.library }), (e: unknown) => e instanceof EmbedError && e.code === 'download_interrupted' && e.fix === `mera-news-local model download --model ${DEFAULT_MODEL}`);
    assert.equal(existsSync(kept), true);
    assert.equal(lib.calls(), 1);
  });

  test('an unreadable file drops the model cache and loads once more', async () => {
    const { cacheDir, kept } = setup();
    const lib = failing(new Error('Protobuf parsing failed'), null);
    await ensureModel({ model: DEFAULT_MODEL, cacheDir, library: lib.library });
    assert.equal(existsSync(kept), false);
    assert.equal(lib.calls(), 2);
  });

  test('a second load failure is reported, not retried again', async () => {
    const { cacheDir } = setup();
    const lib = failing(new Error('Protobuf parsing failed'));
    await assert.rejects(ensureModel({ model: DEFAULT_MODEL, cacheDir, library: lib.library }), (e: unknown) => e instanceof EmbedError && e.code === 'model_load_failed');
    assert.equal(lib.calls(), 2);
  });
});
