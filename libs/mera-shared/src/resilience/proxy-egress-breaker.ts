import {
  circuitBreaker,
  handleWhen,
  SamplingBreaker,
  CircuitBreakerPolicy,
} from 'cockatiel';

/**
 * Pool-wide circuit breaker for the outbound RSS-fetch proxy pool.
 *
 * Background (prod, 2026-08-06 and 2026-08-11). A burst of `HTTP 503`s from the
 * proxy pool put every one of the 48 `load-rss-feed` worker slots on the ~90s
 * three-attempt retry path at once. Throughput collapsed from ~1000 feeds/min
 * to exactly 48/min — flat, for 30 minutes — the queue could not drain inside
 * the hour, and 1,851 then 5,538 jobs were discarded unfetched at the 45-minute
 * queue-age cap. The individual retries were all behaving as designed; what was
 * missing was any notion that the SHARED egress was unwell, so each of 48
 * workers rediscovered that fact independently, 90 seconds at a time.
 *
 * Why not `buildProviderResiliencePolicy` (the composed policy next door):
 *  - its `bulkhead` duplicates BullMQ worker concurrency, and would queue
 *    requests while HOLDING a worker slot and renewing its lock — strictly
 *    worse than simply lowering `FEED_FETCH_CONCURRENCY`, which is free;
 *  - its `retry` multiplies against `AxiosService`'s own proxy round-robin
 *    retry (3 × 4 = 12 attempts × 30s);
 *  - its `timeout` duplicates the per-attempt axios timeout, and would abort
 *    mid-budget, losing the categorisation `FeedFetchError` depends on;
 *  - its `ConsecutiveBreaker` is the wrong shape. This storm is PARTIAL — the
 *    measured baseline 503 rate is ~8% even when healthy — so "5 consecutive
 *    faults" trips by chance regularly at 24-48 interleaved workers, and is
 *    not guaranteed to trip cleanly during a real 60%-fault event either.
 *
 * Only the breaker layer survives that analysis, and it needs a PROPORTIONAL
 * breaker. So this builds one directly rather than importing four layers to use
 * one; `provider-resilience.ts` is deliberately left untouched.
 *
 * Hold ONE instance per service (a Nest singleton). The sharing across all
 * concurrent worker jobs IS the mechanism — a per-job breaker would learn
 * nothing that the job's own retry budget did not already know.
 */

/** Thrown INSTEAD of a fetch error while the pool-wide breaker is open. */
export class ProxyEgressUnavailableError extends Error {
  constructor(message = 'Proxy egress circuit is open') {
    super(message);
    this.name = 'ProxyEgressUnavailableError';
    // Restore the prototype chain for `instanceof` across the TS downlevel —
    // same reason FeedFetchError does it. Every seam that keeps this error away
    // from the feed-health counters is an `instanceof` check, so losing this
    // line would silently re-arm the catalogue-wide quarantine trap.
    Object.setPrototypeOf(this, ProxyEgressUnavailableError.prototype);
  }
}

export interface ProxyEgressBreakerOptions {
  /** Fraction of egress-attributable faults in the window that trips it open. */
  faultThreshold: number;
  /** Rolling window the fault fraction is measured over (ms). */
  samplingDurationMs: number;
  /** Minimum requests/sec in the window before the breaker may open at all. */
  minimumRps: number;
  /** How long it stays open before a single half-open probe (ms). */
  halfOpenAfterMs: number;
}

export const DEFAULT_PROXY_EGRESS_BREAKER: ProxyEgressBreakerOptions = {
  /**
   * 0.5 is reachable ONLY pool-wide. No single origin is more than ~0.1% of the
   * pool's traffic (4,833 feeds), so origin trouble — however severe for that
   * publisher — cannot move the fraction anywhere near half. That is what makes
   * a rate threshold sound here without needing to distinguish a proxy-issued
   * 503 from an origin-issued one, which is not currently possible.
   */
  faultThreshold: 0.5,
  samplingDurationMs: 60_000,
  minimumRps: 3,
  halfOpenAfterMs: 15_000,
};

/** Statuses that mean OUR egress is unwell rather than one publisher's origin. */
const EGRESS_FAULT_STATUSES = new Set([502, 503, 504]);

/**
 * Statuses that can ONLY have been produced by the proxy itself, never by an
 * origin. Deliberately just 407: `Proxy-Authorization` is hop-by-hop, so a 407
 * cannot be forwarded from upstream and is unambiguously our egress.
 *
 * 402 is NOT here and must never be added. Payment Required is a real origin
 * response — paywalls and per-publisher quota use it — so treating a bare 402 as
 * infrastructure would shed that publisher's feed forever: silently, with no
 * history row, no failure counter, never quarantined, and an ERROR-level alert
 * firing for a condition that is purely theirs. 402 stays in `BLOCKED_STATUSES`
 * (feed-failure-policy.ts), where it quarantines with backoff and never
 * deactivates. If a proxy vendor ever surfaces quota exhaustion as 402,
 * discriminate on the response body, never on the status alone.
 *
 * NOT added to EGRESS_FAULT_STATUSES, and that is not an oversight. Once the
 * latch in AxiosService engages it sheds BEFORE `breaker.execute()`, which
 * starves the SamplingBreaker of numerator and denominator alike: throughput
 * through the breaker collapses to one probe per interval (~0.067 rps) against
 * `minimumRps: 3`, so it could never open however bad the fault fraction looks,
 * and its half-open probe could never govern recovery. The latch owns recovery
 * instead. One mechanism, not two.
 */
export const PROXY_INFRA_STATUSES: readonly number[] = [407];

/** Whether a status is proxy-infrastructure-attributable. See the constant. */
export function isProxyInfraStatus(status: number | undefined | null): boolean {
  return typeof status === 'number' && PROXY_INFRA_STATUSES.includes(status);
}

/**
 * Detail of one proxy-infrastructure fault, carried ON THE THROWN ERROR rather
 * than on the AxiosService singleton.
 *
 * That placement is load-bearing. The singleton is shared by all 48 concurrent
 * `load-rss-feed` workers, and this value is written in a catch and read after
 * awaits, so a field would let worker B overwrite worker A's snapshot before A
 * logs it — meaning the `bodySnippet` an operator pages on could belong to a
 * different feed entirely.
 *
 * `instanceIndex` is the index into `PROXY_URLS`, NOT into a country pool, so
 * both fetch paths report the same identity for the same underlying proxy
 * entry. That is what lets the latch tell "one bad credential" (faults from a
 * single entry) from "account-wide quota exhaustion" (faults from several).
 */
export interface ProxyInfraFault {
  status: number;
  code: string | null;
  bodySnippet: string | null;
  instanceIndex: number;
}

/**
 * Whether a failure is attributable to our own egress path.
 *
 * 403 and 429 are deliberately EXCLUDED. Those are per-origin bot protection
 * keyed on the requesting IP, already handled by `BLOCKED_STATUSES` in the feed
 * failure policy without deactivating anything. Counting them would open the
 * breaker whenever a large slice of the catalogue is legitimately unfriendly to
 * datacenter ranges, which is a steady-state property of the corpus and not an
 * incident.
 *
 * Cockatiel does not count errors its filter rejects — neither as numerator nor
 * denominator — so the ratio the breaker sees is exactly
 * `egress faults / (egress faults + clean fetches)`.
 */
export function isEgressFault(error: unknown): boolean {
  // Never let the breaker feed on its own rejection: that is a self-sustaining
  // open circuit which would never recover.
  if (error instanceof ProxyEgressUnavailableError) {
    return false;
  }

  const status = (
    error as { response?: { status?: number } } | undefined | null
  )?.response?.status;

  // No HTTP response at all — connection reset, timeout, TLS failure, a dead
  // proxy. Nothing about the origin is even known yet, so this is ours.
  if (status === undefined || status === null) {
    return true;
  }

  return EGRESS_FAULT_STATUSES.has(status);
}

/**
 * Build the pool-wide breaker. `SamplingBreaker` (not `ConsecutiveBreaker`)
 * because the failure mode being defended against is proportional, not
 * consecutive — see the file header.
 *
 * `minimumRps` is what stops a quiet period from opening the circuit off two
 * unlucky requests; it must be set from a real tick's request profile rather
 * than from an hourly average.
 */
export function buildProxyEgressBreaker(
  options: ProxyEgressBreakerOptions = DEFAULT_PROXY_EGRESS_BREAKER,
): CircuitBreakerPolicy {
  return circuitBreaker(handleWhen(isEgressFault), {
    halfOpenAfter: options.halfOpenAfterMs,
    breaker: new SamplingBreaker({
      threshold: options.faultThreshold,
      duration: options.samplingDurationMs,
      minimumRps: options.minimumRps,
    }),
  });
}
