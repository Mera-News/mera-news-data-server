/**
 * LanguageDetector port (ports & adapters — business logic never imports the
 * CLD3/FastText detector directly). Wraps the existing CLD3-backed
 * `LanguageDetectionService` (apps/mera-server-async/.../language-detection)
 * behind a stable interface so pipeline processors depend on the port, not the
 * concrete implementation.
 *
 * Contract: `detect` returns the detected ISO language code (e.g. `en`, `hi`)
 * or `null` when the text is empty, the detector is unavailable, or the result
 * is unreliable/undetermined — exactly the semantics of the CLD3 service today.
 */
export const LANGUAGE_DETECTOR = 'LANGUAGE_DETECTOR';

export interface LanguageDetector {
  /** Detect the language of `text`; `null` when unknown/unreliable/empty. */
  detect(text: string): string | null;
}
