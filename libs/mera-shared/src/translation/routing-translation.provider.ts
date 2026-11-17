import {
  BrokenCircuitError,
  ConsecutiveBreaker,
  circuitBreaker,
  handleWhen,
  type CircuitBreakerPolicy,
} from 'cockatiel';
import type { JobLogger } from '../job-logger/job-logger';
import type {
  TranslateInput,
  TranslateOutput,
  TranslationProvider,
  TranslationProviderTuning,
} from './translation-provider.port';
import {
  GEMINI_FALLBACK_LEG_RETRIES,
  GEMINI_ONLY_LEG_RETRIES,
  normaliseTranslationLang,
  type RoutedTranslationConfig,
} from './routed-translation-config';
import {
  OpenRouterTranslationService,
  TranslationInfraError,
  type OpenRouterTranslationResult,
  type TranslationFallbackReason,
} from './openrouter-translation.service';
import type { TranslatedText } from './translation-prompt';
import { TranslationSemaphore } from './translation-semaphore';

type SleepFn = (ms: number) => Promise<void>;

/** The Gemini adapter as the router sees it. */
export interface GeminiTranslationLeg extends TranslationProvider {
  usageStats?(): {
    promptTokens: number;
    candidateTokens: number;
    estimatedCostUsd: number;
  };
  readonly activeModel?: string;
  onModuleInit?(): void;
}

export interface RoutingTranslationDeps {
  now?: () => number;
  sleep?: SleepFn;
  /** OpenRouter breaker: consecutive infra failures that open it. */
  breakerThreshold?: number;
  /** OpenRouter breaker: how long it stays open before one probe. */
  breakerHalfOpenMs?: number;
}

/** A bulkhead the caller's policy never fills: the router's two semaphores
 * are the real limits, so a chunk waiting for an OpenRouter permit can never
 * hold a slot a Gemini-language chunk needs. */
const PASS_THROUGH_CONCURRENCY = 10_000;
const GEMINI_LEG_BACKOFF_MS = 250;

interface CallOutcome {
  result?: OpenRouterTranslationResult;
  fallback?: { reason: TranslationFallbackReason; status: number | null };
}

interface LegOutcome {
  byId: Map<string, TranslatedText>;
  costUsd: number;
  fallback: TranslationFallbackReason | null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

/** One signal that aborts when either input does; `dispose` detaches. */
function linkSignals(
  a: AbortSignal | undefined,
  b: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (a?.aborted || b.aborted) ctl.abort();
  a?.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal,
    dispose: () => {
      a?.removeEventListener('abort', onAbort);
      b.removeEventListener('abort', onAbort);
    },
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `TRANSLATION_PROVIDER=routed`: DeepSeek on OpenRouter for the source
 * languages in `TRANSLATION_OPENROUTER_LANGS`, Gemini for every other language
 * AND as the automatic fallback. Translation is on the feed's critical path,
 * so an OpenRouter outage or an empty wallet costs money, never uptime.
 *
 * Per chunk (the batch is single-language):
 *  1. Language not allowlisted: Gemini, with up to 2 router retries.
 *  2. Allowlisted: sub-batches of `batchSize` go to OpenRouter. Misses retry
 *     as single articles; whatever is still missing goes to Gemini as ONE
 *     call. A batch infra failure, an open breaker, the deadline, a full
 *     permit queue or a `content_filter` batch sends that whole sub-batch to
 *     Gemini, logged WARN `translation_openrouter_fallback`.
 *  3. Paid successes are never thrown away: the chunk throws only when
 *     nothing in it was translated and Gemini failed too. Otherwise it returns
 *     the successes plus `skipped` rows, which the caller fails terminally.
 *
 * Time: a deadline (`deadlineMs` from chunk entry, permit waits included)
 * bounds the OpenRouter leg. No OpenRouter call starts unless a full
 * `timeoutMs` still fits inside it, and a permit wait is capped at
 * `permitWaitMs`. A Gemini leg is bounded by its own abort timer linked to the
 * caller's signal. The caller's `chunkTimeoutMs` is a backstop only.
 *
 * Concurrency: one OpenRouter semaphore and one Gemini semaphore. Every call
 * takes and releases its own permit, so the batch permit is released before
 * the singles and before the Gemini leg, and nothing holds one permit while
 * waiting for another. One cockatiel breaker guards the OpenRouter leg and is
 * checked before the permit wait and again (by `execute`) after it.
 */
export class RoutingTranslationProvider implements TranslationProvider {
  readonly tuning: TranslationProviderTuning;

  private readonly orSem: TranslationSemaphore;
  private readonly geminiSem: TranslationSemaphore;
  private readonly breaker: CircuitBreakerPolicy;
  /** cockatiel's `state` stays Open until the next `execute` moves it to
   * half-open, so a pre-check on `state` would never let a probe through.
   * Track the open window on cockatiel's own clock (Date.now) instead. */
  private breakerOpenUntil = 0;
  private readonly now: () => number;
  private readonly sleep: SleepFn;

  constructor(
    private readonly cfg: RoutedTranslationConfig,
    private readonly logger: JobLogger,
    private readonly openrouter: OpenRouterTranslationService,
    private readonly gemini: GeminiTranslationLeg,
    deps: RoutingTranslationDeps = {},
  ) {
    this.orSem = new TranslationSemaphore(cfg.maxConcurrency);
    this.geminiSem = new TranslationSemaphore(cfg.geminiConcurrency);
    this.breaker = circuitBreaker(
      handleWhen((err) => err instanceof TranslationInfraError),
      {
        halfOpenAfter: deps.breakerHalfOpenMs ?? 60_000,
        breaker: new ConsecutiveBreaker(deps.breakerThreshold ?? 5),
      },
    );
    const halfOpenMs = deps.breakerHalfOpenMs ?? 60_000;
    this.breaker.onBreak(() => {
      this.breakerOpenUntil = Date.now() + halfOpenMs;
    });
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.tuning = {
      concurrency: PASS_THROUGH_CONCURRENCY,
      chunkTimeoutMs: cfg.chunkTimeoutMs,
      policyRetries: 0,
    };
  }

  /** Nest calls this on the bound instance only; forward Gemini's boot check. */
  onModuleInit(): void {
    this.gemini.onModuleInit?.();
  }

  async translateBatch(
    items: TranslateInput[],
    signal?: AbortSignal,
  ): Promise<TranslateOutput[]> {
    if (items.length === 0) return [];
    const lang = normaliseTranslationLang(items[0].sourceLang);
    if (!this.cfg.langs.has(lang)) {
      return this.geminiOnly(items, lang, signal);
    }
    return this.routed(items, lang, signal);
  }

  /** Both providers, summed; the per-provider split alongside. */
  usageStats(): {
    promptTokens: number;
    candidateTokens: number;
    estimatedCostUsd: number;
    openrouter: ReturnType<OpenRouterTranslationService['usageStats']>;
    gemini: {
      promptTokens: number;
      candidateTokens: number;
      estimatedCostUsd: number;
    };
  } {
    const or = this.openrouter.usageStats();
    const g = this.gemini.usageStats?.() ?? {
      promptTokens: 0,
      candidateTokens: 0,
      estimatedCostUsd: 0,
    };
    return {
      promptTokens: or.promptTokens + g.promptTokens,
      candidateTokens: or.completionTokens + g.candidateTokens,
      estimatedCostUsd: or.costUsd + g.estimatedCostUsd,
      openrouter: or,
      gemini: g,
    };
  }

  private async geminiOnly(
    items: TranslateInput[],
    lang: string,
    signal?: AbortSignal,
  ): Promise<TranslateOutput[]> {
    try {
      return await this.geminiLeg(items, signal, GEMINI_ONLY_LEG_RETRIES);
    } catch (err) {
      this.logger.error('translation_batch_failed', {
        lang,
        n: items.length,
        skipped: items.length,
        reasons: [`gemini: ${message(err)}`],
      });
      throw err;
    }
  }

  private async routed(
    items: TranslateInput[],
    lang: string,
    signal?: AbortSignal,
  ): Promise<TranslateOutput[]> {
    const deadlineAt = this.now() + this.cfg.deadlineMs;
    const translated = new Map<string, TranslatedText>();
    const leftovers: TranslateInput[] = [];
    const reasons = new Set<string>();
    let orCost = 0;
    let firstFallback: TranslationFallbackReason | null = null;

    const legs = await Promise.all(
      chunk(items, this.cfg.batchSize).map(async (sub) => ({
        sub,
        out: await this.openRouterLeg(sub, lang, deadlineAt, signal),
      })),
    );
    for (const { sub, out } of legs) {
      orCost += out.costUsd;
      for (const [id, text] of out.byId) translated.set(id, text);
      for (const item of sub) if (!out.byId.has(item.id)) leftovers.push(item);
      if (out.fallback) {
        reasons.add(out.fallback);
        firstFallback ??= out.fallback;
      }
    }

    let geminiOut: TranslateOutput[] | null = null;
    let geminiError: unknown = null;
    if (leftovers.length > 0) {
      try {
        geminiOut = await this.geminiLeg(
          leftovers,
          signal,
          GEMINI_FALLBACK_LEG_RETRIES,
        );
      } catch (err) {
        geminiError = err;
        reasons.add(`gemini: ${message(err)}`);
      }
    }

    this.logger.info('translation_route', {
      provider: 'openrouter',
      model: this.openrouter.model,
      lang,
      n: translated.size,
      fellBack: leftovers.length > 0,
      reason: firstFallback,
      costUsd: orCost,
    });

    const byLeftover = new Map<string, TranslateOutput>();
    leftovers.forEach((item, i) => {
      const out = geminiOut?.[i];
      if (out) byLeftover.set(item.id, out);
    });
    const outputs = items.map((item): TranslateOutput => {
      const hit = translated.get(item.id);
      if (hit) return { ...hit, skipped: false };
      return (
        byLeftover.get(item.id) ?? {
          title_en: item.title,
          description_en: item.description,
          skipped: true,
          reason: 'translation_error',
        }
      );
    });

    if (leftovers.length > 0) {
      const served = geminiOut
        ? geminiOut.filter((o) => o && !o.skipped).length
        : 0;
      this.logger.info('translation_route', {
        provider: 'gemini',
        model: this.gemini.activeModel ?? 'gemini',
        lang,
        n: served,
        fellBack: true,
        reason: firstFallback ?? 'miss',
        costUsd: null,
      });
    }

    const skipped = outputs.filter((o) => o.skipped);
    if (skipped.length > 0) {
      for (const o of skipped) if (o.reason) reasons.add(o.reason);
      this.logger.error('translation_batch_failed', {
        lang,
        n: items.length,
        skipped: skipped.length,
        reasons: [...reasons],
      });
    }
    if (geminiError && translated.size === 0) {
      throw new Error(
        `translation failed on both legs: ${[...reasons].join('; ')}`,
      );
    }
    return outputs;
  }

  /** One sub-batch on OpenRouter: batch call, then parallel single retries. */
  private async openRouterLeg(
    sub: TranslateInput[],
    lang: string,
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<LegOutcome> {
    const batch = await this.callOpenRouter(sub, deadlineAt, signal);
    let costUsd = batch.result?.costUsd ?? 0;
    const fallback: CallOutcome['fallback'] =
      batch.fallback ??
      (batch.result?.contentFilter
        ? { reason: 'content_filter_batch', status: 200 }
        : undefined);
    if (fallback) {
      this.logger.warn('translation_openrouter_fallback', {
        reason: fallback.reason,
        status: fallback.status,
        lang,
        n: sub.length,
        model: this.openrouter.model,
      });
      return { byId: new Map(), costUsd, fallback: fallback.reason };
    }

    const byId = new Map(batch.result!.byId);
    const misses = sub.filter((item) => !byId.has(item.id));
    if (misses.length === 0) return { byId, costUsd, fallback: null };

    // The batch permit is already released: each single takes its own.
    const singles = await Promise.all(
      misses.map((item) => this.callOpenRouter([item], deadlineAt, signal)),
    );
    const singleReasons = new Set<string>();
    let recovered = 0;
    singles.forEach((single, i) => {
      costUsd += single.result?.costUsd ?? 0;
      const hit = single.result?.byId.get(misses[i].id);
      if (hit && !single.result?.contentFilter) {
        byId.set(misses[i].id, hit);
        recovered++;
      } else {
        singleReasons.add(
          single.fallback?.reason ??
            (single.result?.contentFilter ? 'content_filter' : 'missing'),
        );
      }
    });
    this.logger.info('translation_openrouter_miss', {
      lang,
      n: misses.length,
      recovered,
      model: this.openrouter.model,
      reasons: [...singleReasons],
    });
    return { byId, costUsd, fallback: null };
  }

  /**
   * One OpenRouter call under the breaker, the deadline and a permit. Never
   * throws: an infra failure or a refusal to start comes back as `fallback`.
   */
  private async callOpenRouter(
    items: TranslateInput[],
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<CallOutcome> {
    const fb = (
      reason: TranslationFallbackReason,
      status: number | null = null,
    ): CallOutcome => ({ fallback: { reason, status } });
    const fits = () => this.now() + this.cfg.timeoutMs <= deadlineAt;

    if (Date.now() < this.breakerOpenUntil) return fb('circuit_open');
    if (!fits()) return fb('deadline');
    const waitCap = Math.min(
      this.cfg.permitWaitMs,
      deadlineAt - this.cfg.timeoutMs - this.now(),
    );
    const release = await this.orSem.acquire(waitCap, signal);
    if (!release) return fb(signal?.aborted ? 'timeout' : 'capacity');
    try {
      if (!fits()) return fb('deadline');
      const result = await this.breaker.execute(() =>
        this.openrouter.translate(items, { signal, deadlineAt }),
      );
      return { result };
    } catch (err) {
      if (err instanceof BrokenCircuitError) return fb('circuit_open');
      if (err instanceof TranslationInfraError)
        return fb(err.reason, err.status);
      return fb('network');
    } finally {
      release();
    }
  }

  /**
   * One Gemini leg: a Gemini permit, an abort timer of `geminiLegTimeoutMs`
   * linked to the caller's signal, and `retries` more attempts on any error
   * (today's whole-batch retry). The Gemini adapter's own backoff sleeps
   * ignore the signal, so one attempt can overrun its timer by ~3.5 s.
   */
  private async geminiLeg(
    items: TranslateInput[],
    signal: AbortSignal | undefined,
    retries: number,
  ): Promise<TranslateOutput[]> {
    let last: unknown = new Error('translation aborted');
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (signal?.aborted) break;
      const release = await this.geminiSem.acquire(Infinity, signal);
      if (!release) break;
      const legCtl = new AbortController();
      const timer = setTimeout(
        () => legCtl.abort(),
        this.cfg.geminiLegTimeoutMs,
      );
      const linked = linkSignals(signal, legCtl.signal);
      try {
        return await this.gemini.translateBatch(items, linked.signal);
      } catch (err) {
        last = err;
        this.logger.warn('translation_gemini_leg_failed', {
          attempt,
          n: items.length,
          timedOut: legCtl.signal.aborted,
          reason: message(err).slice(0, 200),
        });
      } finally {
        clearTimeout(timer);
        linked.dispose();
        release();
      }
      if (attempt < retries && !signal?.aborted) {
        await this.sleep(GEMINI_LEG_BACKOFF_MS * 2 ** attempt);
      }
    }
    throw last;
  }
}
