import { deriveTranslationTuning } from './translation-tuning';

describe('deriveTranslationTuning', () => {
  const base = {
    rpm: 200,
    tpm: 1_000_000,
    avgTokens: 250,
    attentionCap: 20,
    tokenBudget: 6000,
    estRequestSecs: 8,
    hardInflightCap: 20,
  };

  it('caps batch size by the attention cap when tokens allow more', () => {
    // tokenBudget/avgTokens = 24 > attentionCap 20 → 20.
    expect(deriveTranslationTuning(base).maxBatch).toBe(20);
  });

  it('caps batch size by the token budget when it is the tighter bound', () => {
    // budget 2000 / 250 = 8 < attentionCap 20 → 8.
    expect(
      deriveTranslationTuning({ ...base, tokenBudget: 2000 }).maxBatch,
    ).toBe(8);
  });

  it('derives in-flight from RPM and TPM (never below 1)', () => {
    const t = deriveTranslationTuning(base);
    expect(t.maxConcurrentBatches).toBeGreaterThanOrEqual(1);
    expect(t.maxConcurrentBatches).toBeLessThanOrEqual(base.hardInflightCap);
  });

  it('respects the hard in-flight cap', () => {
    const t = deriveTranslationTuning({
      ...base,
      rpm: 100_000,
      tpm: 1_000_000_000,
      hardInflightCap: 3,
    });
    expect(t.maxConcurrentBatches).toBe(3);
  });

  it('is bounded by RPM when the tier is small', () => {
    const t = deriveTranslationTuning({ ...base, rpm: 6, estRequestSecs: 10 });
    // floor(6 * 10/60) = 1
    expect(t.maxConcurrentBatches).toBe(1);
  });

  it('guards against zero/negative inputs', () => {
    const t = deriveTranslationTuning({
      ...base,
      avgTokens: 0,
      estRequestSecs: 0,
    });
    expect(t.maxBatch).toBeGreaterThanOrEqual(1);
    expect(t.maxConcurrentBatches).toBeGreaterThanOrEqual(1);
  });
});
