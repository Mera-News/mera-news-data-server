// One embedding model per call, or --blind to build the rater input.
// usage: node measure.mjs --dir <path> --model <id> [--force] [--limit N]
//        node measure.mjs --dir <path> --blind
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync,
  appendFileSync, truncateSync, openSync, closeSync, readSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string' }, model: { type: 'string' }, force: { type: 'boolean' },
    limit: { type: 'string' }, blind: { type: 'boolean' },
  },
});
if (!args.dir || (!args.model && !args.blind)) {
  console.error('usage: node measure.mjs --dir <path> (--model <id> [--force] [--limit N] | --blind)');
  process.exit(1);
}
const here = dirname(fileURLToPath(import.meta.url));
const D = args.dir;
const LIMIT = args.limit ? Number(args.limit) : null;
const topics = JSON.parse(readFileSync(join(here, 'topics.json'), 'utf8'));
const items = existsSync(join(D, 'sample/items.json'))
  ? JSON.parse(readFileSync(join(D, 'sample/items.json'), 'utf8')) : [];
const ALL = ['e5-small', 'bge-m3', 'qwen3-0.6b', 'jina-v5-nano-nc'];

const QWEN_TASK = 'Instruct: Given a news topic that a reader follows, retrieve news articles about that topic\nQuery:';
// dtype 'q8' resolves to onnx/model_quantized.onnx in transformers.js.
const MODELS = {
  'e5-small': { hub: 'Xenova/multilingual-e5-small', dims: 384, pooling: 'mean', q: 'query: ', d: 'passage: ' },
  'bge-m3': { hub: 'Xenova/bge-m3', dims: 1024, pooling: 'cls', q: '', d: '' },
  'qwen3-0.6b': { hub: 'onnx-community/Qwen3-Embedding-0.6B-ONNX', dims: 1024, pooling: 'last_token', q: QWEN_TASK, d: '' },
  'jina-v5-nano-nc': { hub: 'jinaai/jina-embeddings-v5-text-nano-retrieval', dims: 768, pooling: 'last_token', q: 'Query: ', d: 'Document: ' },
};

const mkdir = (p) => mkdirSync(join(D, p), { recursive: true });
const readJson = (p, dflt) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : dflt);
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 1));
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const p95 = (a) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const dirBytes = (p) => {
  if (!existsSync(p)) return 0;
  return readdirSync(p, { withFileTypes: true }).reduce(
    (s, e) => s + (e.isDirectory() ? dirBytes(join(p, e.name)) : statSync(join(p, e.name)).size), 0);
};

// ---------------------------------------------------------------- blind
if (args.blind) {
  mkdir('rater');
  const have = ALL.filter((id) => existsSync(join(D, 'results', `${id}.json`)));
  if (!have.length) { console.error('no model results yet'); process.exit(1); }
  const res = Object.fromEntries(have.map((id) => [id, readJson(join(D, 'results', `${id}.json`))]));
  const rand = mulberry32(777);
  const lists = [];
  const key = {};
  for (const t of topics) {
    const order = [...have];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const lettered = {};
    key[t.id] = {};
    order.forEach((id, i) => {
      const letter = 'ABCD'[i];
      key[t.id][letter] = id;
      lettered[letter] = res[id].find((r) => r.topicId === t.id).hits.map((h) => ({
        title: h.title, description: (h.description ?? '').slice(0, 200), lang: h.lang,
      }));
    });
    lists.push({ topicId: t.id, topic: t.text, lang: t.lang, lists: lettered });
  }
  writeJson(join(D, 'rater/lists.json'), lists);
  writeJson(join(D, 'rater/key.json'), key);
  console.log(`rater input for ${topics.length} topics, models ${have.join(', ')}`);
  process.exit(0);
}

// ---------------------------------------------------------------- model run
const id = args.model;
const M = MODELS[id];
if (!M) { console.error(`unknown model ${id}; one of ${ALL.join(', ')}`); process.exit(1); }
if (!items.length) { console.error('no sample items; run sample.mjs first'); process.exit(1); }
['checkpoints', 'vectors', 'results', 'summary', 'scan', 'models'].forEach(mkdir);
const ckFile = join(D, 'checkpoints', `${id}.json`);
const vecFile = join(D, 'vectors', `${id}.f32`);
if (args.force) {
  for (const f of [ckFile, vecFile, join(D, 'results', `${id}.json`), join(D, 'summary', `${id}.json`)]) rmSync(f, { force: true });
}
const ck = readJson(ckFile, {});
const save = () => writeJson(ckFile, ck);
const N_EMBED = LIMIT ?? 5000;
const N_REAL = Math.min(N_EMBED, items.length);
const SCANS = LIMIT ? [['scan20k', 2000], ['scan100k', 5000]] : [['scan20k', 20_000], ['scan100k', 100_000]];
const docText = (it) => (M.d + (it.title + '. ' + it.description).slice(0, 1000)).trim();

let extractor = null;
async function getExtractor() {
  if (extractor) return extractor;
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = join(D, 'models');
  const t0 = performance.now();
  extractor = await pipeline('feature-extraction', M.hub, { dtype: 'q8' });
  // The library's last-token pooling takes the last position, which is padding for every
  // shorter text in a batch unless the tokenizer pads on the left.
  if (M.pooling === 'last_token') extractor.tokenizer.padding_side = 'left';
  if (!ck.load) {
    const folder = join(D, 'models', M.hub);
    const onnx = existsSync(join(folder, 'onnx')) ? readdirSync(join(folder, 'onnx')) : [];
    ck.load = {
      loadMs: Math.round(performance.now() - t0), downloadBytes: dirBytes(folder),
      weightsFile: onnx.find((f) => f.endsWith('model_quantized.onnx')) ?? onnx.join(','), loaded: true,
    };
    save();
  }
  return extractor;
}
const embed = async (texts) => {
  const out = await (await getExtractor())(texts, { pooling: M.pooling, normalize: true });
  if (out.dims[1] !== M.dims) throw new Error(`dims ${out.dims[1]}, expected ${M.dims}`);
  return out.data;
};

try {
  // a. load (done lazily by the first stage that needs the model)
  if (!ck.load) { await getExtractor(); }
  console.log(`load: ${(ck.load.loadMs / 1000).toFixed(1)}s, ${(ck.load.downloadBytes / 1e6).toFixed(0)} MB, ${ck.load.weightsFile}`);

  // b. embed, resumable per batch
  if (!ck.embed?.complete) {
    const rowBytes = M.dims * 4;
    let done = Math.min(ck.embed?.done ?? 0, existsSync(vecFile) ? Math.floor(statSync(vecFile).size / rowBytes) : 0, N_EMBED);
    if (existsSync(vecFile)) truncateSync(vecFile, Math.min(done, N_REAL) * rowBytes);
    else writeFileSync(vecFile, '');
    let embedMs = done ? ck.embed.embedMs : 0;
    let peak = done ? ck.embed.peakRssMb : 0;
    const sample = () => { peak = Math.max(peak, process.memoryUsage().rss / 1048576); };
    const timer = setInterval(sample, 250);
    for (let i = done; i < N_EMBED; i += 32) {
      const idx = Array.from({ length: Math.min(32, N_EMBED - i) }, (_, k) => (i + k) % items.length);
      const t0 = performance.now();
      const data = await embed(idx.map((j) => docText(items[j])));
      embedMs += performance.now() - t0;
      sample();
      const keep = idx.filter((_, k) => i + k < N_REAL).length;
      if (keep) appendFileSync(vecFile, Buffer.from(data.buffer, data.byteOffset, keep * rowBytes));
      done = i + idx.length;
      ck.embed = { done, embedMs, peakRssMb: peak, complete: false };
      save();
    }
    clearInterval(timer);
    ck.embed = { done, embedMs: Math.round(embedMs), peakRssMb: Math.round(peak), n: N_EMBED, realItems: N_REAL, complete: true };
    save();
  }
  console.log(`embed: ${ck.embed.n} in ${(ck.embed.embedMs / 1000).toFixed(1)}s, peak ${ck.embed.peakRssMb} MB`);

  // c. topic queries against the real items
  if (!ck.queries?.complete) {
    const buf = readFileSync(vecFile);
    const V = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    const results = [];
    for (let i = 0; i < topics.length; i += 32) {
      const batch = topics.slice(i, i + 32);
      const q = await embed(batch.map((t) => (M.q + t.text).trim()));
      batch.forEach((t, b) => {
        const scores = [];
        for (let r = 0; r < N_REAL; r++) {
          let s = 0;
          for (let k = 0; k < M.dims; k++) s += q[b * M.dims + k] * V[r * M.dims + k];
          scores.push([r, s]);
        }
        scores.sort((x, y) => y[1] - x[1]);
        results.push({
          topicId: t.id,
          hits: scores.slice(0, 10).map(([r, s]) => ({
            idx: r, score: s, title: items[r].title, description: items[r].description,
            lang: items[r].lang, link: items[r].link,
          })),
        });
      });
    }
    writeJson(join(D, 'results', `${id}.json`), results);
    ck.queries = { complete: true };
    save();
  }
  console.log(`queries: ${topics.length} topics done`);
} catch (e) {
  if (id === 'jina-v5-nano-nc') {
    ck.load = { loaded: false, error: String(e.message ?? e) };
    save();
    writeJson(join(D, 'summary', `${id}.json`), { model: id, ...ck.load });
    console.log(`model ${id}: not loaded: ${ck.load.error}`);
    process.exit(0);
  }
  throw e;
}

// d. vector scans on synthetic vectors
async function scan(name, n) {
  const dims = M.dims;
  const nowS = Math.floor(Date.now() / 1000);
  const rand = mulberry32(n * 31 + dims);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const unit = () => {
    const v = new Float32Array(dims);
    let s = 0;
    for (let k = 0; k < dims; k++) { v[k] = gauss(); s += v[k] * v[k]; }
    s = Math.sqrt(s);
    for (let k = 0; k < dims; k++) v[k] /= s;
    return v;
  };
  const blob = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  const out = { n };
  mkdir('scan');
  const vecPath = join(D, 'scan', `${id}-${name}-vec.db`);
  const jsPath = join(D, 'scan', `${id}-${name}-js.db`);
  for (const p of [vecPath, jsPath]) rmSync(p, { force: true });
  const jsDb = new DatabaseSync(jsPath);
  jsDb.exec('create table t(id integer primary key, createdAt integer, vec blob)');
  const jsIns = jsDb.prepare('insert into t(id, createdAt, vec) values (?, ?, ?)');

  let vecDb = null;
  try {
    vecDb = new DatabaseSync(vecPath, { allowExtension: true });
    const sv = await import('sqlite-vec');
    vecDb.loadExtension(sv.getLoadablePath());
    vecDb.exec(`create virtual table v using vec0(embedding float[${dims}], createdAt integer)`);
    out.sqliteVecLoaded = true;
  } catch (e) {
    out.sqliteVecLoaded = false;
    out.sqliteVecError = String(e.message ?? e);
    vecDb = null;
  }
  const vecIns = vecDb?.prepare('insert into v(rowid, embedding, createdAt) values (?, ?, ?)');

  let jsInsMs = 0, vecInsMs = 0;
  const CHUNK = 1000;
  for (let base = 0; base < n; base += CHUNK) {
    const rows = [];
    for (let r = base; r < Math.min(n, base + CHUNK); r++) rows.push([BigInt(r + 1), Math.floor(nowS - rand() * 30 * 86400), unit()]);
    let t0 = performance.now();
    jsDb.exec('begin');
    for (const [rid, c, v] of rows) jsIns.run(rid, c, blob(v));
    jsDb.exec('commit');
    jsInsMs += performance.now() - t0;
    if (vecDb) {
      t0 = performance.now();
      vecDb.exec('begin');
      for (const [rid, c, v] of rows) vecIns.run(rid, blob(v), BigInt(c));
      vecDb.exec('commit');
      vecInsMs += performance.now() - t0;
    }
  }
  const queries = Array.from({ length: 20 }, unit);
  const cutoff = nowS - 15 * 86400;
  const K = 50;

  const jsSel = jsDb.prepare('select id, vec from t where createdAt >= ?');
  const jsTimes = [];
  for (const q of queries) {
    const t0 = performance.now();
    let top = [];
    for (const row of jsSel.iterate(BigInt(cutoff))) {
      const u = row.vec;
      const f = new Float32Array(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength));
      let s = 0;
      for (let k = 0; k < dims; k++) s += q[k] * f[k];
      top.push([row.id, s]);
      if (top.length > 4 * K) { top.sort((a, b) => b[1] - a[1]); top.length = K; }
    }
    top.sort((a, b) => b[1] - a[1]);
    top.length = Math.min(K, top.length);
    jsTimes.push(performance.now() - t0);
  }
  out.js = { insertMs: Math.round(jsInsMs), p50Ms: median(jsTimes), p95Ms: p95(jsTimes) };
  jsDb.close();

  if (vecDb) {
    const sel = vecDb.prepare('select rowid, distance from v where embedding match ? and k = ? and createdAt >= ?');
    const times = [];
    let filteredInKnn = true;
    try {
      for (const q of queries) {
        const t0 = performance.now();
        sel.all(blob(q), BigInt(K), BigInt(cutoff));
        times.push(performance.now() - t0);
      }
    } catch (e) {
      // finding: filtering inside the KNN query is not supported; measure a wider KNN then a filter
      filteredInKnn = false;
      out.sqliteVecFilterError = String(e.message ?? e);
      times.length = 0;
      const wide = vecDb.prepare('select rowid, distance from v where embedding match ? and k = ?');
      const created = vecDb.prepare('select createdAt from v where rowid = ?');
      for (const q of queries) {
        const t0 = performance.now();
        wide.all(blob(q), BigInt(Math.min(n, K * 4))).filter((r) => created.get(r.rowid).createdAt >= cutoff).slice(0, K);
        times.push(performance.now() - t0);
      }
    }
    out.sqliteVec = { insertMs: Math.round(vecInsMs), p50Ms: median(times), p95Ms: p95(times), filteredInKnn };
    vecDb.close();
  }
  for (const p of [vecPath, jsPath]) rmSync(p, { force: true });
  return out;
}
for (const [name, n] of SCANS) {
  if (ck[name]?.complete) { console.log(`${name}: skipped (done)`); continue; }
  ck[name] = { ...(await scan(name, n)), complete: true };
  save();
  const r = ck[name];
  console.log(`${name} (${n}): sqlite-vec ${r.sqliteVec ? `${r.sqliteVec.p50Ms.toFixed(1)}/${r.sqliteVec.p95Ms.toFixed(1)}` : 'n/a'} ms, js ${r.js.p50Ms.toFixed(1)}/${r.js.p95Ms.toFixed(1)} ms`);
}

// e. licence check, first run only
const licFile = join(D, 'licence.json');
if (!existsSync(licFile)) {
  const run = (cmd, cwd) => {
    try { return { ok: true, out: execSync(cmd, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 600_000 }) }; }
    catch (e) { return { ok: false, out: String(e.stdout ?? '') + String(e.stderr ?? '') }; }
  };
  const lic = { sharpTree: run('npm ls sharp --all', here).out };
  const scratch = join(D, 'licence-scratch');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const inst = run('npm install @huggingface/transformers@4.3.2 --omit=optional', scratch);
  lic.scratchInstalled = inst.ok;
  const sharpPresent = existsSync(join(scratch, 'node_modules', 'sharp'));
  lic.sharpInScratch = sharpPresent;
  if (inst.ok) {
    writeFileSync(join(scratch, 'probe.mjs'), `
import { pipeline, env } from '@huggingface/transformers';
env.cacheDir = ${JSON.stringify(join(D, 'models'))};
const ex = await pipeline('feature-extraction', ${JSON.stringify(MODELS['e5-small'].hub)}, { dtype: 'q8' });
const o = await ex(['query: hello'], { pooling: 'mean', normalize: true });
console.log(o.dims.join('x'));`);
    const probe = run('node probe.mjs', scratch);
    lic.embedsWithoutSharp = probe.ok;
    lic.probeOutput = probe.out.slice(-500);
  }
  rmSync(scratch, { recursive: true, force: true });
  writeJson(licFile, lic);
  console.log(`licence: sharp in scratch ${sharpPresent}, embeds without sharp ${lic.embedsWithoutSharp}`);
}

// summary
const r20 = ck.scan20k, r100 = ck.scan100k;
writeJson(join(D, 'summary', `${id}.json`), { model: id, hub: M.hub, dims: M.dims, pooling: M.pooling, limit: LIMIT, load: ck.load, embed: ck.embed, scan20k: r20, scan100k: r100 });
const f = (r) => `${r.sqliteVec ? `${r.sqliteVec.p50Ms.toFixed(1)}/${r.sqliteVec.p95Ms.toFixed(1)}` : 'n/a'} ms, js ${r.js.p50Ms.toFixed(1)}/${r.js.p95Ms.toFixed(1)} ms`;
console.log(`model ${id}: load ${(ck.load.loadMs / 1000).toFixed(1)}s, embed ${ck.embed.n} in ${(ck.embed.embedMs / 1000).toFixed(1)}s, peak ${ck.embed.peakRssMb} MB, download ${(ck.load.downloadBytes / 1e6).toFixed(0)} MB, scan20k(${r20.n}) sqlite-vec p50/p95 ${f(r20)}, scan100k(${r100.n}) sqlite-vec p50/p95 ${f(r100)}`);
