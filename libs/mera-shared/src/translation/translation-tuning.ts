import type { ConfigService } from '@nestjs/config';
/**
 * Adaptive tuning for the translation job (plan "adaptive-config rule": env
 * stores the MEASURED INPUTS — rate limits, average article tokens, attention
 * cap — and the knobs are DERIVED at startup, never hand-set).
 *
 * Inputs (from env):
 *  - rpm            Gemini requests-per-minute tier ceiling
 *  - tpm            Gemini tokens-per-minute tier ceiling
 *  - avgTokens      average input tokens per article (title + description + framing)
 *  - attentionCap   max articles/batch before attention degrades (Decision 1: ~10–20)
 *  - tokenBudget    max input tokens/request (the "fit comfortably" budget)
 *  - estRequestSecs measured mean latency of one batch request
 *
 * Outputs (derived knobs):
 *  - maxBatch                articles per Gemini request = min(attentionCap, tokenBudget/avgTokens)
 *  - maxConcurrentBatches    in-flight requests = min(RPM-bound, TPM-bound, hard cap), ≥ 1
 */
export interface TranslationTuningInputs {
  rpm: number;
  tpm: number;
  avgTokens: number;
  attentionCap: number;
  tokenBudget: number;
  estRequestSecs: number;
  hardInflightCap: number;
}

export interface TranslationTuning {
  maxBatch: number;
  maxConcurrentBatches: number;
}

export function deriveTranslationTuning(
  i: TranslationTuningInputs,
): TranslationTuning {
  const avgTokens = Math.max(1, i.avgTokens);
  const byTokens = Math.max(1, Math.floor(i.tokenBudget / avgTokens));
  const maxBatch = Math.max(1, Math.min(i.attentionCap, byTokens));

  // Little's law-ish: within one mean request latency we may issue RPM*(secs/60)
  // requests without exceeding RPM; likewise cap by TPM given tokens/request.
  const windowFrac = Math.max(0, i.estRequestSecs) / 60;
  const byRpm = Math.max(1, Math.floor(i.rpm * windowFrac));
  const tokensPerRequest = maxBatch * avgTokens;
  const byTpm = Math.max(
    1,
    Math.floor((i.tpm * windowFrac) / Math.max(1, tokensPerRequest)),
  );
  const maxConcurrentBatches = Math.max(
    1,
    Math.min(byRpm, byTpm, i.hardInflightCap),
  );

  return { maxBatch, maxConcurrentBatches };
}

/**
 * {@link deriveTranslationTuning} from the `GEMINI_*` env inputs. One reader
 * so the translate service's chunking and the routed provider's Gemini
 * semaphore can never derive different numbers from the same env.
 */
export function deriveTranslationTuningFromConfig(
  config: ConfigService,
): TranslationTuning & { tokenBudget: number } {
  const tokenBudget = config.get<number>('GEMINI_INPUT_TOKEN_BUDGET', 12000);
  return {
    ...deriveTranslationTuning({
      rpm: config.get<number>('GEMINI_RPM', 200),
      tpm: config.get<number>('GEMINI_TPM', 1_000_000),
      avgTokens: config.get<number>('GEMINI_AVG_ARTICLE_TOKENS', 250),
      attentionCap: config.get<number>('GEMINI_ATTENTION_CAP', 40),
      tokenBudget,
      estRequestSecs: config.get<number>('GEMINI_EST_REQUEST_SECONDS', 8),
      hardInflightCap: config.get<number>('GEMINI_HARD_INFLIGHT_CAP', 20),
    }),
    tokenBudget,
  };
}
