import { readChoice, readText, type ConfigReader } from '../config/env-choice';
import { VECTOR_RETRIEVAL_MIN_SCORE } from '../retrieval/retrieval-constants';

export const EMBEDDING_PROVIDERS = [
  'jina',
  'openai-compatible',
  'fake',
] as const;
export type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];

export const DEFAULT_EMBEDDING_DIMS = 768;

/** The model the score floor, the near-copy bar and the client's score curve were tuned on. */
export const CALIBRATED_JINA_MODEL = 'jina-embeddings-v5-text-nano';

export function embeddingProvider(config: ConfigReader): EmbeddingProviderName {
  return readChoice(config, 'EMBEDDING_PROVIDER', EMBEDDING_PROVIDERS, 'jina');
}

function positiveNumber(config: ConfigReader, key: string): number | null {
  const value = readText(config, key);
  if (value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${key}="${value}" must be a positive number`);
  }
  return n;
}

/** `EMBEDDING_DIMS`, the length of every stored and query vector. */
export function embeddingDims(config: ConfigReader): number {
  const n = positiveNumber(config, 'EMBEDDING_DIMS');
  if (n === null) return DEFAULT_EMBEDDING_DIMS;
  if (!Number.isInteger(n)) {
    throw new Error(`EMBEDDING_DIMS="${n}" must be a whole number`);
  }
  return n;
}

/**
 * True only for the model every score-based rule was tuned on: the Jina
 * adapter (or the test fake, which stands in for it) with the default model at
 * 768 dimensions. Jina reached through the OpenAI-compatible adapter is not.
 */
export function isCalibratedEmbedding(config: ConfigReader): boolean {
  const provider = embeddingProvider(config);
  if (provider === 'openai-compatible') return false;
  const model = readText(config, 'JINA_MODEL');
  return (
    (model === '' || model === CALIBRATED_JINA_MODEL) &&
    embeddingDims(config) === DEFAULT_EMBEDDING_DIMS
  );
}

/** `VECTOR_MIN_SCORE`, the vector-search score floor, between 0 and 1. */
export function vectorMinScore(config: ConfigReader): number {
  const n = positiveNumber(config, 'VECTOR_MIN_SCORE');
  if (n === null) return VECTOR_RETRIEVAL_MIN_SCORE;
  if (n > 1) throw new Error(`VECTOR_MIN_SCORE="${n}" must be at most 1`);
  return n;
}
