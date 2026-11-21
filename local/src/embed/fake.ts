import { createHash } from 'node:crypto';
import { normalize, type Embedder } from './embedder.ts';

/** Deterministic hash of the text into a vector of length 1. Similar texts are not similar. */
export function createFakeEmbedder(dims: number): Embedder {
  const vec = (text: string): Float32Array => {
    const raw = new Float32Array(dims);
    let block = 0;
    for (let i = 0; i < dims; block++) {
      const h = createHash('sha256').update(`${block}:${text}`).digest();
      for (let j = 0; j + 4 <= h.length && i < dims; j += 4) raw[i++] = h.readInt32LE(j) / 2 ** 31;
    }
    return normalize(raw);
  };
  return {
    model: `fake-${dims}`,
    dims,
    embedPassages: async (texts) => texts.map(vec),
    embedQuery: async (text) => vec(text),
  };
}
