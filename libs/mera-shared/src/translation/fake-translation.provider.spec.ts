import { FakeTranslationProvider } from './fake-translation.provider';

describe('FakeTranslationProvider', () => {
  it('passes source text through as the English text (not skipped)', async () => {
    const out = await new FakeTranslationProvider().translateBatch([
      { id: 'a', title: 'Hola', description: 'Mundo', sourceLang: 'es' },
    ]);
    expect(out).toEqual([
      { title_en: 'Hola', description_en: 'Mundo', skipped: false },
    ]);
  });
});
