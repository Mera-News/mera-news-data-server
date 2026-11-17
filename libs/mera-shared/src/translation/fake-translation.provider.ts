import {
  TranslateInput,
  TranslateOutput,
  TranslationProvider,
} from './translation-provider.port';

/**
 * Offline no-op {@link TranslationProvider} bound via
 * `TRANSLATION_PROVIDER=fake` for local CLI verification and unit tests (no real
 * Gemini credits). It carries the source text through as the "English" text so
 * the downstream embedding/clustering plumbing is exercised without an API call.
 */
export class FakeTranslationProvider implements TranslationProvider {
  translateBatch(items: TranslateInput[]): Promise<TranslateOutput[]> {
    return Promise.resolve(
      items.map((i) => ({
        title_en: i.title,
        description_en: i.description,
        skipped: false,
      })),
    );
  }
}
