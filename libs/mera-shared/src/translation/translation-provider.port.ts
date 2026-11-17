/**
 * TranslationProvider port (Decision 1). Business logic never imports the Gemini
 * SDK/REST surface — it hands a language-grouped batch to this port and gets
 * back one aligned result per input.
 *
 * Contract: `translateBatch` returns exactly one {@link TranslateOutput} per
 * input, in input order. Content/structural failures (safety block, id
 * misalignment surviving the single-article retry) come back as
 * `skipped: true` with the ORIGINAL text carried through + a reason — the
 * article still flows downstream untranslated (no data loss, no DLQ). Only
 * infra failures (network, 5xx after retries, auth/config) THROW, so the
 * JobRunner DLQs those items.
 */
export const TRANSLATION_PROVIDER = 'TRANSLATION_PROVIDER';

export interface TranslateInput {
  /** Stable id used for the every-input-id-exactly-once contract. */
  id: string;
  title: string;
  description: string;
  /** Detected source language (ISO code); the batch is single-language. */
  sourceLang: string;
}

export interface TranslateOutput {
  title_en: string;
  description_en: string;
  /** True when translation was skipped (structural/content failure); text is the original. */
  skipped: boolean;
  reason?: string;
}

/**
 * How the caller should wrap this provider's batch calls. Present only on a
 * provider that owns its own HTTP retries, deadlines and concurrency (the
 * `routed` provider). The caller then sizes its bulkhead at `concurrency`,
 * bounds a whole `translateBatch` at `chunkTimeoutMs` and retries it
 * `policyRetries` times (0: a whole-batch retry would re-bill paid calls).
 * Without it the caller keeps the shared PROVIDER_* policy.
 */
export interface TranslationProviderTuning {
  concurrency: number;
  chunkTimeoutMs: number;
  policyRetries: number;
}

export interface TranslationProvider {
  translateBatch(
    items: TranslateInput[],
    signal?: AbortSignal,
  ): Promise<TranslateOutput[]>;
  readonly tuning?: TranslationProviderTuning;
}
