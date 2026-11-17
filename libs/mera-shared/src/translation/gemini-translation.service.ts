import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobLogger } from '../job-logger/job-logger';
import {
  GeminiTransport,
  type GeminiTokenFn,
} from '../gemini/gemini-transport';
import {
  TranslateInput,
  TranslateOutput,
  TranslationProvider,
} from './translation-provider.port';
import {
  buildTranslationPrompt,
  parseAlignedTranslations,
} from './translation-prompt';

type FetchFn = typeof fetch;
type SleepFn = (ms: number) => Promise<void>;

const SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
];

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    trafficType?: string;
  };
}

interface OnceResult {
  byId: Map<string, { title_en: string; description_en: string }>;
  safetyBlocked: boolean;
}

/**
 * Gemini Flash-Lite adapter for {@link TranslationProvider} implementing
 * Decision 1 exactly: one language-grouped request, `responseSchema`
 * `[{id,title_en,description_en}]`, temperature 0, thinking disabled, permissive
 * safety thresholds + block-rate counting, every-input-id-exactly-once
 * validation, and single-article retry for the misaligned/blocked subset.
 *
 * Plain HTTPS via `fetch` (no SDK in business logic). `fetch`/`sleep` injected
 * for deterministic tests. The model name is `GEMINI_TRANSLATION_MODEL`
 * (swappable via env — no code change).
 */
@Injectable()
export class GeminiTranslationService implements TranslationProvider {
  /** Model chain: [primary, ...GEMINI_FALLBACK_MODELS]. `modelIndex` advances
   * (sticky for the process lifetime) only on model-level terminal errors —
   * 404/NOT_FOUND/"model … not available" — never on 429/5xx, which keep the
   * existing transient retry. Guards against a provider-side model rename/
   * removal or config error (the staging 404 incident) stalling translation
   * for hours.
   *
   * Verified by real `generateContent` calls on the vertex transport at
   * `global`: `gemini-3.1-flash-lite` answers, honours `responseSchema`, and
   * bills no thinking tokens under `thinkingConfig: { thinkingBudget: 0 }`
   * (`totalTokenCount` equals prompt + candidates on every response).
   *
   * UNVERIFIED: a retirement date of 2027-05-07 for `gemini-3.1-flash-lite`
   * has been asserted in planning input for this migration and could not be
   * confirmed against Google's deprecations page from here. Treat it as a
   * claim to re-check, not as a fact, before relying on the chain outliving
   * the primary. */
  private readonly models: string[];
  private modelIndex = 0;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly fetchFn: FetchFn;
  private readonly sleep: SleepFn;
  private readonly gemini: GeminiTransport;
  // Vertex Flex PayGo: half price, slower, may be throttled (GEMINI_TRANSLATION_FLEX).
  private readonly flex: boolean;
  private readonly flexTimeoutMs: number;
  // How long one flex call may run before the same request goes once on Standard.
  private readonly flexDeadlineMs: number;

  // Block-rate metric (Decision 1 / Risks). Emitted as a warn line per block.
  private safetyBlocks = 0;
  private requests = 0;

  // Token snapshot for usageStats() — the larger half of the Gemini bill
  // (per-run translation volume exceeds enrichment's) was previously
  // unattributable to any run.
  private promptTokens = 0;
  private candidateTokens = 0;

  constructor(
    config: ConfigService,
    private readonly logger: JobLogger,
    fetchFn?: FetchFn,
    sleep?: SleepFn,
    tokenFn?: GeminiTokenFn,
  ) {
    const primary = config.get<string>(
      'GEMINI_TRANSLATION_MODEL',
      'gemini-3.1-flash-lite',
    );
    const fallbacks = config
      .get<string>('GEMINI_FALLBACK_MODELS', 'gemini-3.5-flash-lite')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0 && m !== primary);
    this.models = [primary, ...fallbacks];
    this.maxRetries = config.get<number>('GEMINI_MAX_RETRIES', 3);
    this.backoffMs = config.get<number>('GEMINI_RETRY_BACKOFF_MS', 500);
    this.fetchFn = fetchFn ?? fetch;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.gemini = new GeminiTransport(config, logger, tokenFn);
    this.flex =
      String(config.get('GEMINI_TRANSLATION_FLEX', 'false')) === 'true';
    this.flexTimeoutMs = Number(config.get('TRANSLATION_CHUNK_TIMEOUT_MS', 0));
    this.flexDeadlineMs = Number(
      config.get('TRANSLATION_FLEX_DEADLINE_MS', 240_000),
    );
  }

  private get model(): string {
    return this.models[this.modelIndex];
  }

  /** The model currently answering (the chain advances on a retired model). */
  get activeModel(): string {
    return this.model;
  }

  /** Resolves when the background model validation kicked off by
   * onModuleInit has finished (tests await this; boot never does). */
  validationDone: Promise<void> = Promise.resolve();

  /** Boot-time model validation: GET /models/{model} for the whole chain.
   * WARNs (`translation_model_unavailable`) on 404/error, NEVER throws.
   * FIRE-AND-FORGET with a hard 5s timeout per fetch — boot
   * must never block on external HTTP (one deploy window coincided with a
   * dependency outage; awaited validation would have eaten into Cloud Run's
   * 4-minute startup-probe budget). */
  onModuleInit(): void {
    this.validationDone = this.validateModels();
  }

  private async validateModels(): Promise<void> {
    // `modelMetadataUrl` returns null on Vertex — that shape does not exist
    // there, and this check is fire-and-forget, so firing it would fail
    // SILENTLY and teach nothing.
    if (!this.gemini.isConfigured) return;
    for (const model of this.models) {
      try {
        const metaUrl = this.gemini.modelMetadataUrl(model);
        if (!metaUrl) return;
        const res = await this.fetchFn(metaUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) {
          this.logger.warn('translation_model_unavailable', {
            model,
            status: res.status,
          });
        }
      } catch (err) {
        this.logger.warn('translation_model_validation_error', {
          model,
          reason: (err as Error).message,
        });
      }
    }
  }

  async translateBatch(
    items: TranslateInput[],
    signal?: AbortSignal,
  ): Promise<TranslateOutput[]> {
    if (items.length === 0) return [];
    this.gemini.assertConfigured();

    // Primary request for the whole language-grouped batch. Transient failures
    // retry internally; a genuine infra failure THROWS → JobRunner DLQs the batch.
    const primary = await this.requestWithRetry(items, signal);

    const outputs = new Array<TranslateOutput>(items.length);
    const failed: number[] = [];
    for (let idx = 0; idx < items.length; idx++) {
      const hit = primary.byId.get(items[idx].id);
      if (hit) {
        outputs[idx] = { ...hit, skipped: false };
      } else {
        failed.push(idx);
      }
    }

    // Misaligned/blocked subset retries as SINGLE-article requests — the
    // structural risk of batching is neutralized by the id contract, not hope.
    for (const idx of failed) {
      outputs[idx] = await this.translateSingle(items[idx], signal);
    }
    return outputs;
  }

  /** Single-article terminal path: on any failure, skip with the original text. */
  private async translateSingle(
    item: TranslateInput,
    signal?: AbortSignal,
  ): Promise<TranslateOutput> {
    try {
      const res = await this.requestWithRetry([item], signal);
      const hit = res.byId.get(item.id);
      if (hit) return { ...hit, skipped: false };
      const reason = res.safetyBlocked ? 'safety_block' : 'id_misalignment';
      if (res.safetyBlocked) {
        this.safetyBlocks++;
        this.logger.warn('translation_safety_block', {
          id: item.id,
          sourceLang: item.sourceLang,
        });
      } else {
        this.logger.warn('translation_id_misalignment', { id: item.id });
      }
      return this.skip(item, reason);
    } catch (err) {
      // Terminal after retries: produce translation_skipped rather than losing
      // the article (one stuck article must not fail the whole batch's DLQ).
      this.logger.warn('translation_terminal_error', {
        id: item.id,
        reason: (err as Error).message,
      });
      return this.skip(item, 'translation_error');
    }
  }

  private skip(item: TranslateInput, reason: string): TranslateOutput {
    return {
      title_en: item.title,
      description_en: item.description,
      skipped: true,
      reason,
    };
  }

  /** One Gemini call with backoff retry on transient (429/5xx/network) errors
   * and model-chain failover on model-level terminal errors (404/NOT_FOUND). */
  private async requestWithRetry(
    items: TranslateInput[],
    signal?: AbortSignal,
  ): Promise<OnceResult> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.requestOnce(items, signal);
      } catch (err) {
        if (err instanceof ModelUnavailableError) {
          // Model-level terminal (NEVER 429/5xx): fail the batch over to the
          // next model in the chain — sticky for the process lifetime.
          if (this.modelIndex < this.models.length - 1) {
            const fromModel = this.models[this.modelIndex];
            this.modelIndex++;
            const toModel = this.models[this.modelIndex];
            this.logger.warn('translation_model_fallback', {
              fromModel,
              toModel,
            });
            continue; // immediate retry on the fallback model, no backoff
          }
          throw err; // chain exhausted
        }
        const transient = err instanceof TransientGeminiError;
        if (transient && attempt < this.maxRetries) {
          attempt++;
          await this.sleep(this.backoffMs * Math.pow(2, attempt - 1));
          continue;
        }
        throw err instanceof TransientGeminiError ? (err.cause ?? err) : err;
      }
    }
  }

  /** Flex first when enabled: a flex call that is shed (429/5xx), drops, or
   * outlives `flexDeadlineMs` is sent once on Standard, so Flex can only ever
   * cost latency up to the deadline, never an untranslated article. */
  private async requestOnce(
    items: TranslateInput[],
    signal?: AbortSignal,
  ): Promise<OnceResult> {
    if (this.flex) {
      const started = Date.now();
      const deadline = AbortSignal.timeout(this.flexDeadlineMs);
      try {
        return await this.callOnce(
          items,
          signal ? AbortSignal.any([signal, deadline]) : deadline,
          true,
        );
      } catch (err) {
        // The caller's own abort, or a non-transient error, is not ours to absorb.
        if (signal?.aborted || !(err instanceof TransientGeminiError))
          throw err;
        this.logger.warn('translation_flex_fallback', {
          reason: deadline.aborted ? 'deadline' : err.message.slice(0, 80),
          ms: Date.now() - started,
          items: items.length,
        });
      }
    }
    return this.callOnce(items, signal, false);
  }

  private async callOnce(
    items: TranslateInput[],
    signal: AbortSignal | undefined,
    flex: boolean,
  ): Promise<OnceResult> {
    this.requests++;
    const started = Date.now();
    const url = this.gemini.generateContentUrl(this.model);
    const headers = await this.gemini.headers({
      flex,
      timeoutMs: this.flexTimeoutMs,
    });
    const body = {
      contents: [
        { role: 'user', parts: [{ text: buildTranslationPrompt(items) }] },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              id: { type: 'STRING' },
              title_en: { type: 'STRING' },
              description_en: { type: 'STRING' },
            },
            required: ['id', 'title_en', 'description_en'],
          },
        },
        // Thinking disabled (Decision 1) — deterministic, cheap, low latency.
        thinkingConfig: { thinkingBudget: 0 },
      },
      safetySettings: SAFETY_CATEGORIES.map((category) => ({
        category,
        threshold: 'BLOCK_NONE',
      })),
    };

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new TransientGeminiError('gemini network error', err);
    }

    if (res.status === 429 || res.status >= 500) {
      const txt = await res.text().catch(() => '');
      throw new TransientGeminiError(
        `gemini ${res.status}: ${txt.slice(0, 200)}`,
      );
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      // Model-level terminal (retired/renamed/unavailable model) → triggers the
      // fallback chain in requestWithRetry. Strictly non-transient statuses
      // only — 429/5xx were already handled above.
      if (GeminiTranslationService.isModelUnavailable(res.status, txt)) {
        throw new ModelUnavailableError(
          this.model,
          `gemini ${res.status}: ${txt.slice(0, 200)}`,
        );
      }
      // Other 4xx (auth/bad request) is a config problem → non-transient, DLQs the batch.
      throw new Error(`gemini ${res.status}: ${txt.slice(0, 200)}`);
    }

    const json = (await res.json()) as GeminiResponse;

    // Accumulate Gemini's own token accounting BEFORE any early return, so a
    // safety-blocked or empty response still counts toward the bill — those
    // calls are charged for their input just like successful ones.
    this.promptTokens += json.usageMetadata?.promptTokenCount ?? 0;
    this.candidateTokens += json.usageMetadata?.candidatesTokenCount ?? 0;
    // Per-call latency and tier: the only way to size flex concurrency.
    this.logger.info('translation_gemini_call', {
      flex,
      ms: Date.now() - started,
      items: items.length,
      trafficType: json.usageMetadata?.trafficType,
    });

    const cand = json.candidates?.[0];
    const blocked =
      json.promptFeedback?.blockReason !== undefined ||
      cand?.finishReason === 'SAFETY';
    const text = cand?.content?.parts?.[0]?.text;
    if (!text) {
      return { byId: new Map(), safetyBlocked: blocked };
    }

    return {
      byId: parseAlignedTranslations(text, items),
      safetyBlocked: blocked,
    };
  }

  /** Model-level terminal detection: 404, NOT_FOUND, or "model … not
   * available/found/supported". NEVER matches 429/5xx (those stay transient). */
  static isModelUnavailable(status: number, body: string): boolean {
    if (status === 429 || status >= 500) return false;
    if (status === 404) return true;
    return (
      /NOT_FOUND/.test(body) ||
      /model\b.{0,120}?\b(is\s+)?(not|no longer)\s+(available|found|supported)/i.test(
        body,
      )
    );
  }

  /** Block-rate snapshot for the run summary (requests seen, safety-blocked singles). */
  blockStats(): { requests: number; safetyBlocks: number } {
    return { requests: this.requests, safetyBlocks: this.safetyBlocks };
  }

  /**
   * Token snapshot for the run summary, with the cost derived from Gemini's
   * own counts rather than from an assumed tokens-per-article ratio. Prices
   * are the published `gemini-3.1-flash-lite` rates, matching the default
   * primary above — mirror `gemini-enrichment.service.ts`'s `usageStats()`
   * if the model changes. Nothing derives these from the configured model id,
   * so a model swap that leaves them behind silently misreports every run.
   */
  usageStats(): {
    promptTokens: number;
    candidateTokens: number;
    estimatedCostUsd: number;
  } {
    const INPUT_USD_PER_TOKEN = 0.25 / 1_000_000;
    const OUTPUT_USD_PER_TOKEN = 1.5 / 1_000_000;
    return {
      promptTokens: this.promptTokens,
      candidateTokens: this.candidateTokens,
      estimatedCostUsd:
        this.promptTokens * INPUT_USD_PER_TOKEN +
        this.candidateTokens * OUTPUT_USD_PER_TOKEN,
    };
  }
}

/** Internal marker for retryable Gemini failures (429/5xx/network). */
class TransientGeminiError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransientGeminiError';
  }
}

/** Model-level terminal failure (retired/unknown model) — triggers chain failover. */
class ModelUnavailableError extends Error {
  constructor(
    readonly model: string,
    message: string,
  ) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}
