import type { ConfigService } from '@nestjs/config';
import type { JobLogger } from '../job-logger/job-logger';
import type { TranslateInput } from './translation-provider.port';
import type { RoutedTranslationConfig } from './routed-translation-config';
import {
  buildTranslationPrompt,
  parseLenientTranslations,
  type TranslatedText,
} from './translation-prompt';

type FetchFn = typeof fetch;
type SleepFn = (ms: number) => Promise<void>;

/**
 * Why an OpenRouter batch was handed to Gemini. A CLOSED set: infra alerts on
 * `translation_openrouter_fallback` filter on these exact strings.
 *  - auth 401/403, credit 402, no_endpoints 404 (pinned host not serving)
 *  - rate_limited 429 and upstream_5xx after the retry budget
 *  - timeout (never retried), network, bad_body (non-JSON reply or any other
 *    4xx, i.e. a request or response nobody can use)
 *  - circuit_open, deadline, capacity, content_filter_batch: router decisions
 */
export type TranslationFallbackReason =
  | 'auth'
  | 'credit'
  | 'no_endpoints'
  | 'rate_limited'
  | 'upstream_5xx'
  | 'timeout'
  | 'network'
  | 'bad_body'
  | 'circuit_open'
  | 'deadline'
  | 'capacity'
  | 'content_filter_batch';

/** An OpenRouter call that produced nothing usable for infra reasons. */
export class TranslationInfraError extends Error {
  constructor(
    readonly reason: TranslationFallbackReason,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'TranslationInfraError';
  }
}

/** What one logical OpenRouter call (HTTP retries included) returned. */
export interface OpenRouterTranslationResult {
  byId: Map<string, TranslatedText>;
  /** The host refused the batch (`finish_reason: content_filter`). */
  contentFilter: boolean;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  /** HTTP requests made, retries included. */
  requests: number;
}

export interface OpenRouterCallOptions {
  signal?: AbortSignal;
  /** Epoch ms. A retry starts only if its sleep plus a full timeout fit. */
  deadlineAt?: number;
}

interface ChatCompletion {
  model?: string;
  provider?: string;
  choices?: {
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    message?: { content?: unknown };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    is_byok?: boolean;
    cost_details?: { upstream_inference_cost?: number | null };
  };
  error?: { code?: number | string; message?: string };
}

const RETRY_AFTER_CAP_MS = 10_000;
const BACKOFF_BASE_MS = 1_000;

/**
 * OpenRouter chat-completions adapter for article translation. One call per
 * batch, the SAME prompt Gemini gets ({@link buildTranslationPrompt}) as the
 * only user message, lenient parse ({@link parseLenientTranslations}).
 *
 * Route: pinned host (`provider.order`, fallbacks OFF), no prompt retention,
 * fp8/bf16 only, reasoning off, temperature 0, a generous `max_tokens` so a
 * host default cap cannot cut a 20-article reply. Nothing here is specific to
 * one model; the model is `TRANSLATION_LLM_MODEL`.
 *
 * Retries: 429, 5xx, a host `finish_reason: error` and network errors get
 * `maxRetries` more attempts (`Retry-After` honoured, capped at 10 s) while a
 * full timeout still fits the caller's deadline. A timeout is NEVER retried:
 * the aborted call may still be billed and a re-issue doubles the latency, so
 * the router hands it to Gemini instead.
 *
 * Plain fetch, no SDK. `OPENROUTER_API_KEY` is read at call time.
 */
export class OpenRouterTranslationService {
  private readonly url: string;
  private readonly fetchFn: FetchFn;
  private readonly sleep: SleepFn;
  private readonly now: () => number;
  private readonly totals = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
  };

  constructor(
    private readonly cfg: RoutedTranslationConfig,
    private readonly config: ConfigService,
    private readonly logger: JobLogger,
    fetchFn?: FetchFn,
    sleep?: SleepFn,
    now?: () => number,
  ) {
    this.url = `${cfg.baseUrl}/chat/completions`;
    this.fetchFn = fetchFn ?? fetch;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = now ?? Date.now;
  }

  get model(): string {
    return this.cfg.model;
  }

  body(items: TranslateInput[]): string {
    return JSON.stringify({
      model: this.cfg.model,
      temperature: 0,
      max_tokens: this.cfg.maxTokens,
      usage: { include: true },
      reasoning: { enabled: false },
      provider: {
        ...(this.cfg.providerOrder.length > 0
          ? { order: this.cfg.providerOrder }
          : {}),
        allow_fallbacks: false,
        data_collection: 'deny',
        ...(this.cfg.quantizations.length > 0
          ? { quantizations: this.cfg.quantizations }
          : {}),
      },
      messages: [{ role: 'user', content: buildTranslationPrompt(items) }],
    });
  }

  /** Throws {@link TranslationInfraError}; a content refusal does not throw. */
  async translate(
    items: TranslateInput[],
    opts: OpenRouterCallOptions = {},
  ): Promise<OpenRouterTranslationResult> {
    const result: OpenRouterTranslationResult = {
      byId: new Map(),
      contentFilter: false,
      costUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      requests: 0,
    };
    try {
      return await this.run(items, opts, result);
    } finally {
      this.totals.requests += result.requests;
      this.totals.promptTokens += result.promptTokens;
      this.totals.completionTokens += result.completionTokens;
      this.totals.costUsd += result.costUsd;
    }
  }

  usageStats(): {
    requests: number;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
  } {
    return { ...this.totals };
  }

  private async run(
    items: TranslateInput[],
    opts: OpenRouterCallOptions,
    result: OpenRouterTranslationResult,
  ): Promise<OpenRouterTranslationResult> {
    const key = this.config.get<string>('OPENROUTER_API_KEY');
    if (!key) {
      throw new TranslationInfraError(
        'auth',
        null,
        'OPENROUTER_API_KEY is not set',
      );
    }
    const body = this.body(items);
    const { signal } = opts;

    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) {
        throw new TranslationInfraError('timeout', null, 'aborted');
      }
      result.requests++;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
      const onAbort = () => ctl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      let res: Response;
      let json: ChatCompletion | null;
      try {
        res = await this.fetchFn(this.url, {
          method: 'POST',
          signal: ctl.signal,
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            'X-Title': 'mera-news translation',
          },
          body,
        });
        json = (await res.json().catch(() => null)) as ChatCompletion | null;
      } catch (err) {
        if (ctl.signal.aborted) {
          throw new TranslationInfraError(
            'timeout',
            null,
            signal?.aborted
              ? 'aborted by caller'
              : `timeout after ${this.cfg.timeoutMs}ms`,
          );
        }
        const failure = new TranslationInfraError(
          'network',
          null,
          `network: ${(err as Error).message}`,
        );
        await this.retryOrThrow(attempt, failure, null, opts);
        continue;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      // The timer can fire while the body is still streaming; `res.json()`
      // then fails and would read as a bad body.
      if (json === null && ctl.signal.aborted) {
        throw new TranslationInfraError(
          'timeout',
          res.status,
          `timeout after ${this.cfg.timeoutMs}ms reading the body`,
        );
      }

      const bodyError = json?.error;
      const status = !res.ok
        ? res.status
        : bodyError
          ? Number(bodyError.code) || 500
          : 200;

      if (status === 200) {
        if (!json) {
          throw new TranslationInfraError('bad_body', 200, 'non-JSON body');
        }
        this.recordUsage(json, result);
        const choice = json.choices?.[0];
        const finish = choice?.finish_reason ?? choice?.native_finish_reason;
        if (finish === 'error') {
          const failure = new TranslationInfraError(
            'upstream_5xx',
            200,
            'host finished with error',
          );
          await this.retryOrThrow(attempt, failure, null, opts);
          continue;
        }
        if (finish === 'content_filter') {
          result.contentFilter = true;
          return result;
        }
        const content = choice?.message?.content;
        result.byId = parseLenientTranslations(
          typeof content === 'string' ? content : '',
          items,
        );
        return result;
      }

      const message = String(bodyError?.message ?? `HTTP ${status}`).slice(
        0,
        200,
      );
      const failure = new TranslationInfraError(
        OpenRouterTranslationService.reasonFor(status),
        status,
        `openrouter ${status}: ${message}`,
      );
      if (status === 429 || status >= 500) {
        await this.retryOrThrow(attempt, failure, res, opts);
        continue;
      }
      throw failure;
    }
  }

  /** HTTP status to the closed fallback-reason set. */
  static reasonFor(status: number): TranslationFallbackReason {
    if (status === 401 || status === 403) return 'auth';
    if (status === 402) return 'credit';
    if (status === 404) return 'no_endpoints';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'upstream_5xx';
    return 'bad_body';
  }

  /** Sleeps before the next attempt, or throws when out of budget or time. */
  private async retryOrThrow(
    attempt: number,
    failure: TranslationInfraError,
    res: Response | null,
    opts: OpenRouterCallOptions,
  ): Promise<void> {
    if (attempt >= this.cfg.maxRetries) throw failure;
    const wait =
      (res && this.retryAfterMs(res)) ?? BACKOFF_BASE_MS * 2 ** attempt;
    if (
      opts.deadlineAt !== undefined &&
      this.now() + wait + this.cfg.timeoutMs > opts.deadlineAt
    ) {
      throw failure;
    }
    this.logger.warn('translation_openrouter_retry', {
      attempt,
      reason: failure.reason,
      status: failure.status,
    });
    await this.sleep(wait);
  }

  private recordUsage(
    json: ChatCompletion,
    result: OpenRouterTranslationResult,
  ): void {
    const u = json.usage ?? {};
    result.promptTokens += u.prompt_tokens ?? 0;
    result.completionTokens += u.completion_tokens ?? 0;
    // A BYOK-served call reports `cost` as OpenRouter's fee only; the model
    // price is in `cost_details.upstream_inference_cost`.
    const cost = typeof u.cost === 'number' ? u.cost : 0;
    const upstream =
      u.is_byok === true &&
      typeof u.cost_details?.upstream_inference_cost === 'number'
        ? u.cost_details.upstream_inference_cost
        : 0;
    result.costUsd += cost + upstream;
  }

  private retryAfterMs(res: Response): number | null {
    const h = res.headers?.get?.('retry-after');
    if (!h) return null;
    const secs = Number(h);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - this.now();
    if (!Number.isFinite(ms) || ms < 0) return null;
    return Math.min(ms, RETRY_AFTER_CAP_MS);
  }
}
