import { ConfigService } from '@nestjs/config';
import { JobLogger } from '../job-logger/job-logger';
import type {
  ArticleEnrichmentProvider,
  EnrichmentBatchResult,
  EnrichmentBatchUsage,
  EnrichmentInput,
  EnrichmentOutput,
  EnrichmentProviderTuning,
} from './article-enrichment-provider.port';
import { SYSTEM_PROMPT, buildUserPayload } from './enrichment-spec';
import {
  degradedEnrichment,
  normalizeRow,
  parseAlignedRows,
} from './enrichment-normalizer';
import type { PlaceGazetteer } from './place-gazetteer';

type FetchFn = typeof fetch;
type SleepFn = (ms: number) => Promise<void>;

/** Where the adapter gets its gazetteer. `LazyPlaceGazetteer` in production. */
export interface GazetteerSource {
  get(): Promise<PlaceGazetteer>;
}

/**
 * An infra-shaped failure: network, 5xx or 429 after the adapter's own
 * retries, 401/402/403/404, a non-context 400, a missing API key, or a batch
 * whose every item failed. The caller marks the sub-batch TAGGING_FAILED and
 * the fanout sweep re-drives it. Never used for a per-item content failure,
 * which degrades instead.
 */
export class EnrichmentInfraError extends Error {
  constructor(
    message: string,
    readonly usage?: EnrichmentBatchUsage,
  ) {
    super(message);
    this.name = 'EnrichmentInfraError';
  }
}

/** Why a call's output could not be used for some or all of its items. */
type ItemFailure =
  | 'content_filter'
  | 'length'
  | 'context_length'
  | 'non_array'
  | 'missing_ids';

interface CallOutcome {
  rows: Map<string, Record<string, unknown>> | null;
  itemFailure?: ItemFailure;
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
  };
  error?: { code?: number | string; message?: string };
}

const RETRY_AFTER_CAP_MS = 60_000;
const BACKOFF_CAP_MS = 30_000;
const CONTEXT_LENGTH =
  /context[\s_-]*(length|window)|maximum context|too many tokens|prompt is too long|token limit/i;

function emptyUsage(): EnrichmentBatchUsage {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    models: {},
    providers: {},
    itemFallbacks: 0,
    degraded: 0,
  };
}

function addUsage(into: EnrichmentBatchUsage, u: EnrichmentBatchUsage): void {
  into.requests += u.requests;
  into.promptTokens += u.promptTokens;
  into.completionTokens += u.completionTokens;
  into.costUsd += u.costUsd;
  into.itemFallbacks += u.itemFallbacks;
  into.degraded += u.degraded;
  for (const [k, v] of Object.entries(u.models)) {
    into.models[k] = (into.models[k] ?? 0) + v;
  }
  for (const [k, v] of Object.entries(u.providers)) {
    into.providers[k] = (into.providers[k] ?? 0) + v;
  }
}

function positiveNumber(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const n = Number(config.get<string | number>(key));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = config.get<string | number>(key);
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(n) && n >= 0
    ? n
    : fallback;
}

function csv(config: ConfigService, key: string, fallback: string): string[] {
  return String(config.get<string>(key) ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * OpenAI-compatible chat-completions adapter for {@link ArticleEnrichmentProvider}
 * (`ARTICLE_ENRICHMENT_PROVIDER=openrouter`). Default route: DeepSeek V4.1
 * Flash on OpenRouter, pinned to the tested host with fallbacks OFF so a
 * request can never land on a host that refuses China-politics articles, no
 * prompt retention, fp8/bf16 only, thinking off, temperature 0.
 *
 * Env names are host-neutral: a direct OpenAI-compatible host is a change of
 * `ENRICHMENT_LLM_BASE_URL` plus `ENRICHMENT_LLM_ROUTING=none`, which drops
 * the OpenRouter-only body fields (`provider`, `reasoning`, `usage`).
 *
 * Plain fetch through ConfigService, no SDK; `fetch`/`sleep` injectable.
 * `OPENROUTER_API_KEY` is read at CALL time, never at construction, so the
 * worker boots without it.
 *
 * Per-item failure handling: a call whose output is unusable for some items
 * (content_filter, finish "length", a context-length 400, a non-array reply,
 * missing ids) BISECTS the missing items into halves and retries each half,
 * down to single items; a single item that still fails comes back degraded.
 * A multi-item batch where EVERY item ends degraded throws instead, because a
 * wall of degraded rows is how a contract break (a model or host swap that
 * stopped returning the array) would otherwise pass as a healthy run.
 */
export class OpenRouterEnrichmentService implements ArticleEnrichmentProvider {
  readonly tuning: EnrichmentProviderTuning;

  private readonly url: string;
  private readonly model: string;
  private readonly routing: 'openrouter' | 'none';
  private readonly providerOrder: string[];
  private readonly quantizations: string[];
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly categoryEnabled: boolean;
  private readonly fetchFn: FetchFn;
  private readonly sleep: SleepFn;
  private readonly totals = emptyUsage();

  constructor(
    private readonly config: ConfigService,
    private readonly logger: JobLogger,
    private readonly gazetteer: GazetteerSource,
    fetchFn?: FetchFn,
    sleep?: SleepFn,
  ) {
    const base = String(
      config.get<string>('ENRICHMENT_LLM_BASE_URL') ||
        'https://openrouter.ai/api/v1',
    ).replace(/\/+$/, '');
    this.url = `${base}/chat/completions`;
    this.model =
      config.get<string>('ENRICHMENT_LLM_MODEL') ||
      'deepseek/deepseek-v4.1-flash';
    this.routing =
      String(config.get<string>('ENRICHMENT_LLM_ROUTING') ?? 'openrouter')
        .trim()
        .toLowerCase() === 'none'
        ? 'none'
        : 'openrouter';
    this.providerOrder = csv(
      config,
      'ENRICHMENT_LLM_PROVIDER_ORDER',
      'deepinfra',
    );
    this.quantizations = csv(
      config,
      'ENRICHMENT_LLM_QUANTIZATIONS',
      'fp8,bf16',
    );
    this.maxTokens = positiveNumber(config, 'ENRICHMENT_LLM_MAX_TOKENS', 8192);
    this.timeoutMs = positiveNumber(
      config,
      'ENRICHMENT_LLM_TIMEOUT_MS',
      120_000,
    );
    this.maxRetries = nonNegativeInt(config, 'ENRICHMENT_LLM_MAX_RETRIES', 3);
    this.backoffMs = positiveNumber(
      config,
      'ENRICHMENT_LLM_RETRY_BACKOFF_MS',
      2000,
    );
    this.categoryEnabled =
      String(
        config.get<string | boolean>('ENRICHMENT_CATEGORY_ENABLED', false),
      ).toLowerCase() === 'true';
    this.tuning = {
      batchSize: positiveNumber(config, 'ENRICHMENT_LLM_BATCH_SIZE', 20),
      concurrency: positiveNumber(config, 'ENRICHMENT_LLM_MAX_CONCURRENCY', 8),
      chunkTimeoutMs: positiveNumber(
        config,
        'ENRICHMENT_LLM_CHUNK_TIMEOUT_MS',
        900_000,
      ),
      policyRetries: 0,
    };
    this.fetchFn = fetchFn ?? fetch;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async enrichBatch(
    items: EnrichmentInput[],
    signal?: AbortSignal,
  ): Promise<EnrichmentOutput[]> {
    return (await this.enrichBatchWithUsage(items, signal)).outputs;
  }

  async enrichBatchWithUsage(
    items: EnrichmentInput[],
    signal?: AbortSignal,
  ): Promise<EnrichmentBatchResult> {
    const usage = emptyUsage();
    if (items.length === 0) return { outputs: [], usage };
    const gazetteer = await this.gazetteer.get();

    const byId = new Map<string, EnrichmentOutput>();
    // One request never carries more than `tuning.batchSize` articles, the
    // size the prompt was measured at, whatever size the caller hands in (the
    // backfill sizes its own batches).
    const size = Math.max(1, Math.floor(this.tuning.batchSize));
    try {
      for (let i = 0; i < items.length; i += size) {
        const chunk = items.slice(i, i + size);
        const degradedBefore = usage.degraded;
        await this.resolve(chunk, signal, gazetteer, usage, byId, true);
        if (
          chunk.length > 1 &&
          usage.degraded - degradedBefore === chunk.length
        ) {
          this.logger.error('enrichment_batch_all_degraded', {
            size: chunk.length,
            model: this.model,
          });
          throw new EnrichmentInfraError(
            `every item of a ${chunk.length}-item batch degraded`,
          );
        }
      }
    } catch (err) {
      addUsage(this.totals, usage);
      if (err instanceof EnrichmentInfraError) {
        throw new EnrichmentInfraError(err.message, usage);
      }
      throw err;
    }
    addUsage(this.totals, usage);
    return {
      outputs: items.map((i) => byId.get(i.id) ?? degradedEnrichment(i.id)),
      usage,
    };
  }

  /** Cumulative usage since construction, same shape as the Gemini adapter's. */
  usageStats(): {
    promptTokens: number;
    candidateTokens: number;
    estimatedCostUsd: number;
    requests: number;
    models: Record<string, number>;
    providers: Record<string, number>;
    degraded: number;
    itemFallbacks: number;
  } {
    return {
      promptTokens: this.totals.promptTokens,
      candidateTokens: this.totals.completionTokens,
      estimatedCostUsd: this.totals.costUsd,
      requests: this.totals.requests,
      models: { ...this.totals.models },
      providers: { ...this.totals.providers },
      degraded: this.totals.degraded,
      itemFallbacks: this.totals.itemFallbacks,
    };
  }

  private async resolve(
    items: EnrichmentInput[],
    signal: AbortSignal | undefined,
    gazetteer: PlaceGazetteer,
    usage: EnrichmentBatchUsage,
    byId: Map<string, EnrichmentOutput>,
    top: boolean,
  ): Promise<void> {
    const outcome = await this.call(items, signal, usage);
    const missing: EnrichmentInput[] = [];
    for (const item of items) {
      const row = outcome.rows?.get(item.id);
      if (row) {
        byId.set(item.id, {
          id: item.id,
          ...normalizeRow(row, gazetteer, this.categoryEnabled),
        });
      } else {
        missing.push(item);
      }
    }
    if (missing.length === 0) return;

    const reason = outcome.itemFailure ?? 'missing_ids';
    if (items.length === 1) {
      usage.degraded++;
      byId.set(items[0].id, degradedEnrichment(items[0].id));
      this.logger.warn('tagging_degraded', { id: items[0].id, reason });
      return;
    }
    this.logger.warn('enrichment_item_fallback', {
      reason,
      size: items.length,
      missing: missing.length,
    });
    if (top) usage.itemFallbacks += missing.length;
    if (missing.length === 1) {
      await this.resolve(missing, signal, gazetteer, usage, byId, false);
      return;
    }
    const mid = Math.ceil(missing.length / 2);
    await this.resolve(
      missing.slice(0, mid),
      signal,
      gazetteer,
      usage,
      byId,
      false,
    );
    await this.resolve(
      missing.slice(mid),
      signal,
      gazetteer,
      usage,
      byId,
      false,
    );
  }

  private body(items: EnrichmentInput[]): string {
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: 0,
      max_tokens: this.maxTokens,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPayload(items) },
      ],
    };
    if (this.routing === 'openrouter') {
      body.reasoning = { enabled: false };
      body.usage = { include: true };
      body.provider = {
        ...(this.providerOrder.length > 0 ? { order: this.providerOrder } : {}),
        allow_fallbacks: false,
        data_collection: 'deny',
        ...(this.quantizations.length > 0
          ? { quantizations: this.quantizations }
          : {}),
      };
    }
    return JSON.stringify(body);
  }

  /** One logical call: HTTP retries for 429/5xx/network live here. */
  private async call(
    items: EnrichmentInput[],
    signal: AbortSignal | undefined,
    usage: EnrichmentBatchUsage,
  ): Promise<CallOutcome> {
    const key = this.config.get<string>('OPENROUTER_API_KEY');
    if (!key) {
      throw new EnrichmentInfraError('OPENROUTER_API_KEY is not set');
    }
    const body = this.body(items);
    const ids = new Set(items.map((i) => i.id));

    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new EnrichmentInfraError('aborted');
      usage.requests++;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
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
            'X-Title': 'mera-news enrichment',
          },
          body,
        });
        json = (await res.json().catch(() => null)) as ChatCompletion | null;
      } catch (err) {
        if (signal?.aborted) throw new EnrichmentInfraError('aborted');
        const why = ctl.signal.aborted
          ? `timeout after ${this.timeoutMs}ms`
          : (err as Error).message;
        if (attempt < this.maxRetries) {
          this.logger.warn('enrichment_llm_retry', { attempt, reason: why });
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw new EnrichmentInfraError(`network: ${why}`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }

      const bodyError = json?.error;
      const status = !res.ok
        ? res.status
        : bodyError
          ? Number(bodyError.code) || 500
          : 200;

      if (status === 200 && json) {
        this.recordUsage(json, usage);
        const choice = json.choices?.[0];
        const finish = choice?.finish_reason ?? choice?.native_finish_reason;
        if (finish === 'error' && attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        if (finish === 'error') {
          throw new EnrichmentInfraError('host finished with error');
        }
        const content = choice?.message?.content;
        const rows = parseAlignedRows(
          typeof content === 'string' ? content : '',
          ids,
        );
        let itemFailure: ItemFailure | undefined;
        if (finish === 'content_filter') itemFailure = 'content_filter';
        else if (finish === 'length') itemFailure = 'length';
        else if (rows === null) itemFailure = 'non_array';
        else if (rows.size < items.length) itemFailure = 'missing_ids';
        if (itemFailure === 'content_filter') {
          this.logger.warn('tagging_content_filter', {
            size: items.length,
            provider: json.provider ?? null,
          });
        }
        return { rows, itemFailure };
      }

      const message = String(bodyError?.message ?? `HTTP ${res.status}`);
      if (status === 402) {
        throw new EnrichmentInfraError(`out of credit (402): ${message}`);
      }
      if (status === 413 || (status === 400 && CONTEXT_LENGTH.test(message))) {
        return { rows: null, itemFailure: 'context_length' };
      }
      if ((status === 429 || status >= 500) && attempt < this.maxRetries) {
        this.logger.warn('enrichment_llm_retry', { attempt, status });
        await this.sleep(this.retryAfterMs(res) ?? this.backoff(attempt));
        continue;
      }
      throw new EnrichmentInfraError(
        `enrichment host ${status}: ${message.slice(0, 200)}`,
      );
    }
  }

  private recordUsage(json: ChatCompletion, usage: EnrichmentBatchUsage): void {
    const u = json.usage ?? {};
    usage.promptTokens += u.prompt_tokens ?? 0;
    usage.completionTokens += u.completion_tokens ?? 0;
    usage.costUsd += typeof u.cost === 'number' ? u.cost : 0;
    const model = json.model || this.model;
    const provider = json.provider || 'unknown';
    usage.models[model] = (usage.models[model] ?? 0) + 1;
    usage.providers[provider] = (usage.providers[provider] ?? 0) + 1;
  }

  private backoff(attempt: number): number {
    return Math.min(this.backoffMs * 2 ** attempt, BACKOFF_CAP_MS);
  }

  private retryAfterMs(res: Response): number | null {
    const h = res.headers?.get?.('retry-after');
    if (!h) return null;
    const secs = Number(h);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - Date.now();
    if (!Number.isFinite(ms) || ms < 0) return null;
    return Math.min(ms, RETRY_AFTER_CAP_MS);
  }
}
