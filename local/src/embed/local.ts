import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EmbedError, batches, normalize, type Embedder } from './embedder.ts';
import { MODELS, type ModelSpec } from './models.ts';

export interface Progress {
  file: string;
  doneBytes: number;
  totalBytes: number;
}

export interface EnsureOptions {
  model: string;
  cacheDir: string;
  onProgress?: (p: Progress) => void;
  /** Stands in for @huggingface/transformers in tests. */
  library?: { env: { cacheDir?: string }; pipeline: (...args: any[]) => Promise<any> };
}

export interface LocalOptions extends EnsureOptions {
  batchSize?: number;
}

function spec(id: string): ModelSpec {
  const m = MODELS[id];
  if (!m) throw new EmbedError('model_unknown', `The model ${id} is not one of ${Object.keys(MODELS).join(', ')}.`, `mera-news-local model download --model ${Object.keys(MODELS)[0]}`);
  return m;
}

// The library writes each file to a temporary name and renames it when complete, so an
// interrupted download leaves only `*.tmp.*` leftovers and never a half file under the real
// name. It does not resume: the file starts again. We sweep the leftovers before each load.
function sweepTemp(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) sweepTemp(p);
    else if (/\.tmp\.[^/]*$/.test(n)) rmSync(p, { force: true });
  }
}

const LIBRARY = '@huggingface/transformers';

async function loadLibrary(o: EnsureOptions): Promise<any> {
  if (o.library) return o.library;
  try {
    // A variable specifier keeps the typecheck independent of the optional install.
    return await import(LIBRARY);
  } catch {
    throw new EmbedError('model_runtime_missing', 'The in-process model runtime @huggingface/transformers is not installed.', 'npm ci');
  }
}

async function loadPipeline(m: ModelSpec, o: EnsureOptions): Promise<any> {
  const lib = await loadLibrary(o);
  lib.env.cacheDir = o.cacheDir;
  sweepTemp(o.cacheDir);
  const progress_callback = (e: { status?: string; file?: string; loaded?: number; total?: number }) => {
    if (e.status === 'progress' && e.file) o.onProgress?.({ file: e.file, doneBytes: e.loaded ?? 0, totalBytes: e.total ?? 0 });
  };
  // dtype q8 resolves to onnx/model_quantized.onnx, the same as the bench.
  const make = () => lib.pipeline('feature-extraction', m.hubId, { dtype: 'q8', revision: m.revision, cache_dir: o.cacheDir, progress_callback });
  try {
    return await make();
  } catch (first) {
    // A network failure keeps every file already complete; the next run fetches only the rest.
    if (isNetworkFailure(first)) {
      throw new EmbedError('download_interrupted', `The download of ${m.id} was interrupted: ${(first as Error).message}`, `mera-news-local model download --model ${m.id}`);
    }
    // A file that is present but cannot be read (disk damage, a replaced file): drop this model's cache and fetch once more.
    rmSync(join(o.cacheDir, m.hubId), { recursive: true, force: true });
    try {
      return await make();
    } catch (second) {
      if (isNetworkFailure(second)) {
        throw new EmbedError('download_interrupted', `The download of ${m.id} was interrupted: ${(second as Error).message}`, `mera-news-local model download --model ${m.id}`);
      }
      throw new EmbedError('model_load_failed', `The model ${m.id} could not be loaded: ${(first as Error).message}`, `mera-news-local model download --model ${m.id}`);
    }
  }
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR']);

/** True when the error, or anything in its cause chain, is a failed or cut connection rather than a bad file. */
export function isNetworkFailure(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
    const message = (e as { message?: unknown }).message;
    if (typeof message === 'string' && /fetch failed|network|socket hang up|terminated|aborted/i.test(message)) return true;
  }
  return false;
}

/** Downloads the model files if missing; files already complete in the cache are not fetched again. */
export async function ensureModel(o: EnsureOptions): Promise<void> {
  await loadPipeline(spec(o.model), o);
}

export async function createLocalEmbedder(o: LocalOptions): Promise<Embedder> {
  const m = spec(o.model);
  const batchSize = o.batchSize ?? 32;
  const extractor = await loadPipeline(m, o);
  async function embed(texts: string[], prefix: string): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const b of batches(texts, batchSize)) {
      const t = await extractor(b.map((x) => prefix + x), { pooling: m.pooling, normalize: true });
      const flat = t.data as Float32Array;
      for (let i = 0; i < b.length; i++) out.push(normalize(flat.subarray(i * m.dims, (i + 1) * m.dims)));
    }
    return out;
  }
  return {
    model: m.id,
    dims: m.dims,
    embedPassages: (texts) => embed(texts, m.passagePrefix),
    embedQuery: async (text) => (await embed([text], m.queryPrefix))[0]!,
  };
}
