/**
 * Feed failure policy — decides what a failed RSS fetch should cost a feed.
 *
 * Background: the previous rule was "3 consecutive failures => is_active=false,
 * forever". Because BullMQ retried each job and nothing ever set is_active back
 * to true, ~11% of the catalog was permanently switched off, ~95% of it by
 * transient causes (403 bot-protection, 5xx, timeouts, one-off parse errors,
 * and even feeds that were simply quiet overnight).
 *
 * The policy here replaces that with two ideas:
 *   1. QUARANTINE, not death. A failing feed gets an exponential backoff via
 *      `fetch_next_attempt_at` and keeps being retried. `is_active` is not
 *      touched for anything that a different hour or a different egress IP
 *      could plausibly fix.
 *   2. Deactivate only on EVIDENCE. Either the status is unambiguously about
 *      the URL rather than the network (404/410/…), or the recorded fetch
 *      history shows a long, unbroken run of failures with zero successes.
 *
 * Pure functions only — no Nest, Mongoose or axios imports — so both
 * mera-server-async (the fetch path) and mera-scripts (the audit/revive
 * tooling) can share one definition of "is this feed actually dead".
 */

export type FeedFailureSeverity =
  | 'permanent'
  | 'blocked'
  | 'transient'
  | 'benign';

export type FeedFailureAction =
  | 'ignore'
  | 'retry_next_cycle'
  | 'quarantine'
  | 'deactivate';

/**
 * Statuses that describe the URL, not the connection. A different egress IP or
 * a later hour cannot fix these, so they are allowed to deactivate a feed.
 */
export const PERMANENT_STATUSES = [401, 404, 405, 410, 451];

/**
 * Statuses that mean "this IP is not welcome right now" — bot protection, rate
 * limiting, proxy auth. Very often transient and very often fixed by rotating
 * egress. These NEVER deactivate a feed; they only slow it down.
 */
export const BLOCKED_STATUSES = [402, 403, 407, 429];

export interface FeedFailurePolicyConfig {
  /** Counted failure cycles of a PERMANENT status before deactivation. */
  permanentThreshold: number;
  /** Days of unbroken failure with zero successes before "chronically dead". */
  deadMinDays: number;
  /** Recorded fetch attempts required alongside `deadMinDays`. */
  deadMinAttempts: number;
  /** Failure count at which backoff starts (below this: retry next cycle). */
  backoffStartFailures: number;
  /** First backoff step, in minutes. */
  backoffBaseMinutes: number;
  /** Upper bound on a backoff step, in minutes. */
  backoffMaxMinutes: number;
  /** Re-probe cadence for already-deactivated feeds, in minutes. */
  probeIntervalMinutes: number;
}

export const DEFAULT_FEED_FAILURE_POLICY: FeedFailurePolicyConfig = {
  permanentThreshold: 3,
  deadMinDays: 7,
  deadMinAttempts: 20,
  backoffStartFailures: 3,
  backoffBaseMinutes: 60,
  backoffMaxMinutes: 360,
  probeIntervalMinutes: 1440,
};

/** Rollup of a feed's recorded fetch history over the retention window. */
export interface FeedFetchHistory {
  successes: number;
  failures: number;
  /** createdAt of the oldest recorded attempt, or null when none exist. */
  oldestAt: Date | null;
}

export interface FeedFailureDecision {
  severity: FeedFailureSeverity;
  action: FeedFailureAction;
  /** When the feed should next be fetched; null = next cycle, no delay. */
  nextAttemptAt: Date | null;
  /** Short machine-ish explanation, used for logs and deactivation_severity. */
  reason: string;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Map a fetch failure to a severity. `httpStatus` wins when present, because a
 * category of 'http_status' alone says nothing about whether it is retryable.
 */
export function classifyFeedFailure(input: {
  category?: string | null;
  httpStatus?: number | null;
}): FeedFailureSeverity {
  const { category, httpStatus } = input;

  if (typeof httpStatus === 'number') {
    if (PERMANENT_STATUSES.includes(httpStatus)) {
      return 'permanent';
    }
    if (BLOCKED_STATUSES.includes(httpStatus)) {
      return 'blocked';
    }
    // 5xx (incl. Cloudflare 520-526), 400, 408, and anything else with a
    // response: the origin or edge is unwell, which is a transient condition.
    if (httpStatus >= 400) {
      return 'transient';
    }
  }

  // A feed that parsed cleanly and simply has no items right now is a quiet
  // publisher, not a broken feed. It must never count against the feed.
  if (category === 'empty_feed') {
    return 'benign';
  }

  // 'timeout' | 'network' | 'parse_error' | 'empty_response' | unknown.
  return 'transient';
}

/**
 * Backoff delay in minutes for the Nth consecutive failure. Bounded so that
 * even a permanently-sick feed still gets several attempts a day — recovery
 * has to remain possible without manual action.
 */
export function backoffMinutes(
  consecutiveFailures: number,
  config: FeedFailurePolicyConfig,
): number {
  if (consecutiveFailures < config.backoffStartFailures) {
    return 0;
  }
  const steps = consecutiveFailures - config.backoffStartFailures;
  const delay = config.backoffBaseMinutes * Math.pow(2, steps);
  return Math.min(delay, config.backoffMaxMinutes);
}

/**
 * Whether the recorded history proves the feed is chronically dead: a long
 * enough elapsed window, enough recorded attempts, and not a single success.
 * One success anywhere in the window makes this impossible — which is the
 * whole point.
 */
export function isChronicallyDead(
  history: FeedFetchHistory,
  now: Date,
  config: FeedFailurePolicyConfig,
): boolean {
  if (history.successes > 0) {
    return false;
  }
  if (history.failures < config.deadMinAttempts) {
    return false;
  }
  if (!history.oldestAt) {
    return false;
  }
  const spanMs = now.getTime() - history.oldestAt.getTime();
  return spanMs >= config.deadMinDays * DAY_MS;
}

/**
 * Decide what to do about a failed fetch.
 *
 * Deactivation happens in exactly two cases:
 *   - a PERMANENT status sustained for `permanentThreshold` counted cycles, or
 *   - `isChronicallyDead(...)` — zero successes across a long, well-attested
 *     window.
 * Everything else quarantines with backoff and stays active.
 */
export function decideFeedFailureAction(input: {
  severity: FeedFailureSeverity;
  consecutiveFailures: number;
  history: FeedFetchHistory;
  isDeactivated: boolean;
  now: Date;
  config: FeedFailurePolicyConfig;
}): FeedFailureDecision {
  const { severity, consecutiveFailures, history, isDeactivated, now, config } =
    input;

  if (severity === 'benign') {
    return {
      severity,
      action: 'ignore',
      nextAttemptAt: null,
      reason: 'feed parsed with zero items (quiet publisher)',
    };
  }

  // Already deactivated: this was a probe. Never escalate further, just re-arm
  // the probe timer so the feed keeps getting a chance to come back.
  if (isDeactivated) {
    return {
      severity,
      action: 'quarantine',
      nextAttemptAt: new Date(
        now.getTime() + config.probeIntervalMinutes * MINUTE_MS,
      ),
      reason: 'probe of a deactivated feed failed; re-armed probe timer',
    };
  }

  if (
    severity === 'permanent' &&
    consecutiveFailures >= config.permanentThreshold
  ) {
    return {
      severity,
      action: 'deactivate',
      nextAttemptAt: new Date(
        now.getTime() + config.probeIntervalMinutes * MINUTE_MS,
      ),
      reason: `permanent HTTP status for ${consecutiveFailures} consecutive cycles`,
    };
  }

  if (isChronicallyDead(history, now, config)) {
    return {
      severity,
      action: 'deactivate',
      nextAttemptAt: new Date(
        now.getTime() + config.probeIntervalMinutes * MINUTE_MS,
      ),
      reason: `no successful fetch in ${config.deadMinDays}+ days across ${history.failures} attempts`,
    };
  }

  const delay = backoffMinutes(consecutiveFailures, config);
  if (delay === 0) {
    return {
      severity,
      action: 'retry_next_cycle',
      nextAttemptAt: null,
      reason: `${severity} failure ${consecutiveFailures}; retrying next cycle`,
    };
  }

  return {
    severity,
    action: 'quarantine',
    nextAttemptAt: new Date(now.getTime() + delay * MINUTE_MS),
    reason: `${severity} failure ${consecutiveFailures}; backing off ${delay}m`,
  };
}
