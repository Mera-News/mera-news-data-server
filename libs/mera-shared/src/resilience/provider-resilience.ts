import {
  wrap,
  retry,
  circuitBreaker,
  timeout,
  bulkhead,
  handleAll,
  ExponentialBackoff,
  ConsecutiveBreaker,
  TimeoutStrategy,
  IPolicy,
} from 'cockatiel';

/**
 * Per-chunk provider-call resilience policy.
 *
 * Wraps each Gemini / Jina chunk call in a composed cockatiel policy so a job
 * NEVER dies because some of its provider requests died — the failure is
 * confined to the chunk (surfaced as a rejected promise the caller settles with
 * `Promise.allSettled`, then persists as failure records).
 *
 * Composition (outermost → innermost):
 *  - bulkhead(concurrency)  — the shared semaphore; caps in-flight chunk calls
 *    across ALL concurrent jobs (the policy is a singleton per service). Excess
 *    calls queue rather than reject.
 *  - retry(exp + jitter)    — heals transient network/5xx blips; replaces the
 *    hand-rolled AbortController+retry the per-item processors used.
 *  - circuitBreaker         — fixes the 2026-07-09 failure mode (an hour of
 *    per-item 404 discovery): once the provider is known-down (N consecutive
 *    faults) the breaker fast-fails the remaining chunks to failure records in
 *    milliseconds instead of grinding through every retry.
 *  - timeout(Aggressive)    — bounds a single attempt and passes an AbortSignal
 *    through to the provider call.
 *
 * The port interfaces (TranslationProvider / EmbeddingProvider) are untouched —
 * this is the thin wrapper at the chunk-call boundary only.
 */
export interface ProviderResilienceOptions {
  /** Max concurrent chunk calls (the semaphore width). */
  concurrency: number;
  /** Retries AFTER the first attempt (0 = single attempt; used in tests). */
  retryAttempts: number;
  /** Initial exponential backoff delay (ms). */
  backoffMs: number;
  /** Max exponential backoff delay (ms). */
  maxBackoffMs: number;
  /** Consecutive faults that trip the breaker open. */
  breakerThreshold: number;
  /** How long the breaker stays open before a half-open probe (ms). */
  breakerHalfOpenMs: number;
  /** Per-attempt timeout (ms). */
  timeoutMs: number;
  /** Bulkhead queue depth (how many calls may wait for a slot). */
  queueDepth?: number;
}

export const DEFAULT_PROVIDER_RESILIENCE: Omit<
  ProviderResilienceOptions,
  'concurrency'
> = {
  retryAttempts: 3,
  backoffMs: 250,
  maxBackoffMs: 10_000,
  breakerThreshold: 5,
  breakerHalfOpenMs: 15_000,
  timeoutMs: 60_000,
  queueDepth: 100_000,
};

/**
 * Build the composed policy. Hold ONE instance per service (singleton) so the
 * bulkhead and circuit breaker are shared across concurrent jobs.
 */
export function buildProviderResiliencePolicy(
  options: ProviderResilienceOptions,
): IPolicy {
  return wrap(
    bulkhead(
      Math.max(1, options.concurrency),
      options.queueDepth ?? DEFAULT_PROVIDER_RESILIENCE.queueDepth!,
    ),
    retry(handleAll, {
      maxAttempts: Math.max(0, options.retryAttempts),
      backoff: new ExponentialBackoff({
        initialDelay: options.backoffMs,
        maxDelay: options.maxBackoffMs,
      }),
    }),
    circuitBreaker(handleAll, {
      halfOpenAfter: options.breakerHalfOpenMs,
      breaker: new ConsecutiveBreaker(Math.max(1, options.breakerThreshold)),
    }),
    timeout(options.timeoutMs, TimeoutStrategy.Aggressive),
  );
}
