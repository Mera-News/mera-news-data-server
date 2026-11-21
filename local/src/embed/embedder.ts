export interface Embedder {
  readonly model: string;
  readonly dims: number;
  /** Vectors of length 1, same order as the input. */
  embedPassages(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

/** A refusal with a short machine-readable code and a fix the person can act on. */
export class EmbedError extends Error {
  readonly code: string;
  readonly fix: string;
  constructor(code: string, message: string, fix: string) {
    super(message);
    this.name = 'EmbedError';
    this.code = code;
    this.fix = fix;
  }
}

export function normalize(v: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(v);
  let sum = 0;
  for (const x of out) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm > 0) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export function* batches<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
