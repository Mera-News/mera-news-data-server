import { createHash } from 'crypto';
import { EmbeddingProvider } from './embedding-provider.port';

const EMBED_DIMS = 768;

/**
 * Deterministic, offline {@link EmbeddingProvider} for local CLI verification
 * and unit tests (bound via `EMBEDDING_PROVIDER=fake`) so no
 * real Jina credits are spent when exercising the topic-add mutation against
 * the local dev stack. Produces a stable, L2-normalized 768-dim pseudo-vector
 * per text (same text -> same vector).
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(
      texts.map((t) => FakeEmbeddingProvider.vectorFor(t)),
    );
  }

  static vectorFor(text: string): number[] {
    const vec = new Array<number>(EMBED_DIMS);
    for (let i = 0; i < EMBED_DIMS; i++) {
      const h = createHash('sha256').update(`${text}#${i}`).digest();
      const n = h.readUInt32BE(0) / 0xffffffff;
      vec[i] = n * 2 - 1;
    }
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return vec.map((v) => v / norm);
  }
}
