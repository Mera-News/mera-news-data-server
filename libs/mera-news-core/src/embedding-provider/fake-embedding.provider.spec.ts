import { FakeEmbeddingProvider } from './fake-embedding.provider';

describe('FakeEmbeddingProvider (graphql)', () => {
  const p = new FakeEmbeddingProvider();

  it('produces 768-dim L2-normalized vectors', async () => {
    const [v] = await p.embed(['hello']);
    expect(v).toHaveLength(768);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('is deterministic per text and distinct across texts', async () => {
    const a1 = FakeEmbeddingProvider.vectorFor('a');
    const a2 = FakeEmbeddingProvider.vectorFor('a');
    const b = FakeEmbeddingProvider.vectorFor('b');
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
  });

  it('embeds a batch aligned to input', async () => {
    const out = await p.embed(['x', 'y', 'z']);
    expect(out).toHaveLength(3);
  });
});
