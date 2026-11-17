import type { ConfigService } from '@nestjs/config';
import type { JobLogger } from '../job-logger/job-logger';
import { deriveTranslationTuningFromConfig } from './translation-tuning';

/**
 * Source languages (normalised, see {@link normaliseTranslationLang}) sent to
 * OpenRouter by default: the adjudicated pass set of the translation
 * bake-off's round 3 for DeepSeek V4 Flash 0731 (57 codes, ~85% of
 * non-English volume). Everything else goes to Gemini. Override with
 * `TRANSLATION_OPENROUTER_LANGS`; re-derive the list when the model changes.
 */
export const DEFAULT_TRANSLATION_OPENROUTER_LANGS =
  'ar,az,bs,ca,ceb,cs,da,de,el,es,eu,fr,gl,ha,he,hr,hu,hy,id,is,it,ka,km,kn,' +
  'ko,ky,lb,lt,lv,mk,ml,ms,ne,nl,no,or,pa,pt,ro,ru,sd,sl,sn,sq,sr,sv,sw,ta,' +
  'tg,th,tr,uk,ur,uz,vi,xh,zh';

/** Worst-case overshoot of one Gemini leg past its own timeout: the Gemini
 * adapter's internal backoff sleeps (0.5 + 1 + 2 s) ignore the abort signal. */
export const GEMINI_LEG_SLACK_MS = 5_000;
/** Router retries of a Gemini leg: a Gemini-only chunk / a fallback leg. */
export const GEMINI_ONLY_LEG_RETRIES = 2;
export const GEMINI_FALLBACK_LEG_RETRIES = 1;

/** Validated settings for the `routed` translation provider. */
export interface RoutedTranslationConfig {
  baseUrl: string;
  model: string;
  providerOrder: string[];
  quantizations: string[];
  langs: Set<string>;
  batchSize: number;
  maxTokens: number;
  maxConcurrency: number;
  timeoutMs: number;
  maxRetries: number;
  deadlineMs: number;
  permitWaitMs: number;
  geminiLegTimeoutMs: number;
  geminiConcurrency: number;
  chunkTimeoutMs: number;
}

/** Lowercase, cut a region/script suffix, `iw` (legacy Hebrew) -> `he`. */
export function normaliseTranslationLang(
  raw: string | null | undefined,
): string {
  const base = String(raw ?? '')
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  if (!base) return 'unknown';
  return base === 'iw' ? 'he' : base;
}

function csv(config: ConfigService, key: string, fallback: string): string[] {
  const raw = config.get<string>(key);
  const value =
    raw === undefined || raw === null || String(raw).trim() === ''
      ? fallback
      : String(raw);
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Read and validate every `TRANSLATION_*` knob of the routed provider. Never
 * throws: an invalid or inconsistent value is replaced and logged as WARN
 * `translation_config_clamped` {key, from, to}, because a typo in a tuning
 * knob must not take the translate worker down.
 *
 * Consistency rules (each call starts only if it fits the deadline, so these
 * keep every budget reachable):
 *  - `timeoutMs <= deadlineMs`
 *  - `permitWaitMs <= deadlineMs - timeoutMs`
 *  - `chunkTimeoutMs` (the outer backstop) covers the deadline plus two
 *    fallback Gemini legs, and three legs of a Gemini-only chunk.
 */
export function resolveRoutedTranslationConfig(
  config: ConfigService,
  logger: JobLogger,
): RoutedTranslationConfig {
  const clamp = (key: string, from: unknown, to: number | string): void => {
    logger.warn('translation_config_clamped', { key, from, to });
  };
  const num = (key: string, fallback: number, min: number): number => {
    const raw = config.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min) {
      clamp(key, raw, fallback);
      return fallback;
    }
    return Math.floor(n);
  };

  const baseUrl = String(
    config.get<string>('TRANSLATION_LLM_BASE_URL') ||
      'https://openrouter.ai/api/v1',
  ).replace(/\/+$/, '');
  const model =
    String(config.get<string>('TRANSLATION_LLM_MODEL') ?? '').trim() ||
    'deepseek/deepseek-v4-flash-0731';

  let langs = new Set(
    csv(
      config,
      'TRANSLATION_OPENROUTER_LANGS',
      DEFAULT_TRANSLATION_OPENROUTER_LANGS,
    ).map(normaliseTranslationLang),
  );
  if (langs.size === 0) {
    clamp('TRANSLATION_OPENROUTER_LANGS', '', 'default');
    langs = new Set(DEFAULT_TRANSLATION_OPENROUTER_LANGS.split(','));
  }

  const deadlineMs = num('TRANSLATION_LLM_DEADLINE_MS', 270_000, 1);
  let timeoutMs = num('TRANSLATION_LLM_TIMEOUT_MS', 120_000, 1);
  if (timeoutMs > deadlineMs) {
    clamp('TRANSLATION_LLM_TIMEOUT_MS', timeoutMs, deadlineMs);
    timeoutMs = deadlineMs;
  }
  let permitWaitMs = num('TRANSLATION_LLM_PERMIT_WAIT_MS', 20_000, 0);
  if (permitWaitMs > deadlineMs - timeoutMs) {
    clamp(
      'TRANSLATION_LLM_PERMIT_WAIT_MS',
      permitWaitMs,
      deadlineMs - timeoutMs,
    );
    permitWaitMs = deadlineMs - timeoutMs;
  }
  const geminiLegTimeoutMs = num(
    'TRANSLATION_GEMINI_LEG_TIMEOUT_MS',
    60_000,
    1,
  );
  const leg = geminiLegTimeoutMs + GEMINI_LEG_SLACK_MS;
  const minChunk = Math.max(
    deadlineMs + (GEMINI_FALLBACK_LEG_RETRIES + 1) * leg,
    (GEMINI_ONLY_LEG_RETRIES + 1) * leg,
  );
  let chunkTimeoutMs = num('TRANSLATION_ROUTED_CHUNK_TIMEOUT_MS', 600_000, 1);
  if (chunkTimeoutMs < minChunk) {
    clamp('TRANSLATION_ROUTED_CHUNK_TIMEOUT_MS', chunkTimeoutMs, minChunk);
    chunkTimeoutMs = minChunk;
  }

  return {
    baseUrl,
    model,
    providerOrder: csv(config, 'TRANSLATION_LLM_PROVIDER_ORDER', 'deepinfra'),
    quantizations: csv(config, 'TRANSLATION_LLM_QUANTIZATIONS', 'fp8,bf16'),
    langs,
    batchSize: num('TRANSLATION_LLM_BATCH_SIZE', 20, 1),
    maxTokens: num('TRANSLATION_LLM_MAX_TOKENS', 16_000, 1),
    maxConcurrency: num('TRANSLATION_LLM_MAX_CONCURRENCY', 64, 1),
    timeoutMs,
    maxRetries: num('TRANSLATION_LLM_MAX_RETRIES', 1, 0),
    deadlineMs,
    permitWaitMs,
    geminiLegTimeoutMs,
    geminiConcurrency: Math.max(
      1,
      Number(deriveTranslationTuningFromConfig(config).maxConcurrentBatches) ||
        1,
    ),
    chunkTimeoutMs,
  };
}
