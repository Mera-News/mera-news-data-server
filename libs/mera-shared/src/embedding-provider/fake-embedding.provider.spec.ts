import { FakeEmbeddingProvider } from './fake-embedding.provider';

describe('FakeEmbeddingProvider', () => {
  const p = new FakeEmbeddingProvider();

  it('produces 768-dim L2-normalized vectors', async () => {
    const [v] = await p.embed(['hello'], 'retrieval.passage');
    expect(v).toHaveLength(768);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('returns different vectors for the same text under different tasks', async () => {
    const [ret] = await p.embed(['hello'], 'retrieval.passage');
    const [match] = await p.embed(['hello'], 'text-matching');
    expect(ret).not.toEqual(match);
  });

  it('is deterministic per text and distinct across texts', async () => {
    const a1 = FakeEmbeddingProvider.vectorFor('a');
    const a2 = FakeEmbeddingProvider.vectorFor('a');
    const b = FakeEmbeddingProvider.vectorFor('b');
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
  });

  it('embeds a batch aligned to input', async () => {
    const out = await p.embed(['x', 'y', 'z'], 'retrieval.passage');
    expect(out).toHaveLength(3);
  });
});
