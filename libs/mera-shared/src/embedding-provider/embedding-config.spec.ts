import {
  embeddingDims,
  embeddingProvider,
  isCalibratedEmbedding,
  vectorMinScore,
} from './embedding-config';

const env = (values: Record<string, string | undefined>) => ({
  get: <T>(key: string) => values[key] as T | undefined,
});

describe('embedding config', () => {
  it('defaults to jina at 768 dims and a 0.78 floor', () => {
    expect(embeddingProvider(env({}))).toBe('jina');
    expect(embeddingDims(env({ EMBEDDING_DIMS: '' }))).toBe(768);
    expect(vectorMinScore(env({}))).toBe(0.78);
  });

  it('refuses an unknown provider', () => {
    expect(() =>
      embeddingProvider(env({ EMBEDDING_PROVIDER: 'openai' })),
    ).toThrow(
      'EMBEDDING_PROVIDER="openai" is not one of: jina, openai-compatible, fake',
    );
  });

  it('reads dims as a positive whole number', () => {
    expect(embeddingDims(env({ EMBEDDING_DIMS: '1024' }))).toBe(1024);
    expect(() => embeddingDims(env({ EMBEDDING_DIMS: '0' }))).toThrow();
    expect(() => embeddingDims(env({ EMBEDDING_DIMS: '76.8' }))).toThrow();
    expect(() => embeddingDims(env({ EMBEDDING_DIMS: 'abc' }))).toThrow();
  });

  it('reads the floor between 0 and 1', () => {
    expect(vectorMinScore(env({ VECTOR_MIN_SCORE: '0.6' }))).toBe(0.6);
    expect(() => vectorMinScore(env({ VECTOR_MIN_SCORE: '1.5' }))).toThrow();
    expect(() => vectorMinScore(env({ VECTOR_MIN_SCORE: '-1' }))).toThrow();
  });

  it('is calibrated only for the tuned Jina model at 768 dims', () => {
    expect(isCalibratedEmbedding(env({}))).toBe(true);
    expect(isCalibratedEmbedding(env({ EMBEDDING_PROVIDER: 'fake' }))).toBe(
      true,
    );
    expect(
      isCalibratedEmbedding(
        env({ JINA_MODEL: 'jina-embeddings-v5-text-nano' }),
      ),
    ).toBe(true);
    expect(
      isCalibratedEmbedding(env({ JINA_MODEL: 'jina-embeddings-v4' })),
    ).toBe(false);
    expect(isCalibratedEmbedding(env({ EMBEDDING_DIMS: '1024' }))).toBe(false);
    expect(
      isCalibratedEmbedding(env({ EMBEDDING_PROVIDER: 'openai-compatible' })),
    ).toBe(false);
  });
});
