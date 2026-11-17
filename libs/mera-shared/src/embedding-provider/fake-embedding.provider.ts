import { createHash } from 'crypto';
import {
  EmbeddingProvider,
  type EmbeddingTask,
} from './embedding-provider.port';

const EMBED_DIMS = 768;

/**
 * Deterministic, offline {@link EmbeddingProvider} for local CLI verification
 * and unit tests (bound via `EMBEDDING_PROVIDER=fake`) — the plan explicitly
 * allows fake adapters for CLI runs so no real Jina credits are spent. Produces
 * a stable, L2-normalized 768-dim pseudo-vector per text (same text → same
 * vector), which is enough to exercise the pipeline and clustering plumbing.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  // `task` is part of the seed so the two tasks yield distinct vectors for the
  // same text (matches the real provider, where each task is a different head).
  embed(texts: string[], task: EmbeddingTask): Promise<number[][]> {
    return Promise.resolve(
      texts.map((t) => FakeEmbeddingProvider.vectorFor(`${task}:${t}`)),
    );
  }

  static vectorFor(text: string): number[] {
    const vec = new Array<number>(EMBED_DIMS);
    // Expand a sha256 seed into 768 dims via a simple counter hash.
    for (let i = 0; i < EMBED_DIMS; i++) {
      const h = createHash('sha256').update(`${text}#${i}`).digest();
      // Map first 4 bytes to a float in [-1, 1).
      const n = h.readUInt32BE(0) / 0xffffffff;
      vec[i] = n * 2 - 1;
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return vec.map((v) => v / norm);
  }
}
