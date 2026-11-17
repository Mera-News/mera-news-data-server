/**
 * URL security — the state an article's `article_url` is in, and the policy for
 * escalating a feed that keeps emitting insecure ones.
 *
 * Two INDEPENDENT state machines live here, and keeping them independent is the
 * whole design:
 *
 *   (1) PER ARTICLE — `UrlSecurityState`. Answers "may this row ever be served?"
 *       It is a state, not a boolean, because "http" is three different
 *       situations: already https, was http but the https twin resolved (so we
 *       stored the https URL), and was http with no working https twin. Only the
 *       last one is unservable, and collapsing the first two into "not insecure"
 *       would lose the fact that we rewrote the URL.
 *
 *   (2) PER FEED — `decideHttpLinksEscalation`. Answers "has this publisher had
 *       long enough to fix its links?" Deliberately separate from the
 *       fetch-failure counters in `feed-failure-policy.ts`: a feed can be
 *       perfectly reachable and still publish nothing but http links, and a feed
 *       can be down for a week while every link it ever published was https.
 *       Both counters advance on their own evidence and whichever trips first
 *       deactivates. Nothing here reads or writes `fetch_next_attempt_at`,
 *       `consecutive_fetch_failures` or `fetch_failing_since`.
 *
 * NOTE the deliberate ASYMMETRY between the two: a feed is never escalated for
 * being FETCHED over http. ~9% of active feeds are, and that says nothing about
 * the links they publish — it is our connection to them, not their readers'
 * connection to the article. Only an article that lands `insecure` counts.
 *
 * Pure functions and plain data only — no Nest, Mongoose or network imports —
 * so the ingest path, the GraphQL serving paths and the backfill script all
 * share one definition of "servable" and one definition of "out of patience".
 */

/**
 * What we know about an article's `article_url`.
 *
 * ABSENT (the field unset) is a FOURTH, implicit state meaning "never
 * evaluated" — every row written before this field existed, and every row
 * written while the ingest probe is switched off. Absent rows are SERVABLE:
 * `SERVABLE_URL_SECURITY_FILTER` uses `$ne: 'insecure'`, so the safe default for
 * ~304k legacy documents is the status quo rather than a silent blackout of the
 * whole corpus. The backfill command is what turns absent into a real value.
 */
export enum UrlSecurityState {
  /** `article_url` was already https. Nothing was rewritten. */
  SECURE = 'secure',
  /** `article_url` was http, the https twin resolved, the https URL is stored. */
  UPGRADED = 'upgraded',
  /** `article_url` was http with no working https twin. Stored as-is, NEVER served. */
  INSECURE = 'insecure',
}

export const URL_SECURITY_STATE_VALUES: UrlSecurityState[] = [
  UrlSecurityState.SECURE,
  UrlSecurityState.UPGRADED,
  UrlSecurityState.INSECURE,
];

/**
 * The one filter fragment every serving path spreads into its query/`$match`.
 *
 * Exported as a shared constant rather than written out at each of the ~10 call
 * sites so the exclusion is grep-auditable: one symbol to search for tells you
 * whether a new read path remembered to exclude insecure rows. Frozen because a
 * shared literal that anything could mutate would silently unblock every path
 * at once.
 *
 * `$ne` (not `$in: [secure, upgraded]`) is load-bearing — it must keep matching
 * documents where the field is absent. See `UrlSecurityState`.
 */
export const SERVABLE_URL_SECURITY_FILTER: {
  readonly url_security_state: { readonly $ne: UrlSecurityState };
} = Object.freeze({
  url_security_state: Object.freeze({ $ne: UrlSecurityState.INSECURE }),
});

// ───────────────────────────────────────────────────────────────────────────
// Per-feed escalation
// ───────────────────────────────────────────────────────────────────────────

export interface HttpLinksPolicyConfig {
  /** Distinct UTC days of insecure links before the feed is blocked forever. */
  blockAfterDays: number;
}

export const DEFAULT_HTTP_LINKS_POLICY: HttpLinksPolicyConfig = {
  blockAfterDays: 7,
};

/**
 * `deactivation_reason` stamped on a permanently-blocked feed.
 *
 * This value is what composes with the EXISTING quarantine machinery instead of
 * adding a second deactivation path: `publication-source.model.ts` documents
 * that only `'auto_fetch_failures'` is eligible for the auto-reactivation probe.
 * Because this reason is not that one, the probe skips these feeds BY
 * CONSTRUCTION — "forever" needs no new code, only a reason the prober already
 * ignores.
 */
export const HTTP_LINKS_DEACTIVATION_REASON = 'http_links_permanent';

/** `deactivation_severity` stamped alongside the reason above. */
export const HTTP_LINKS_DEACTIVATION_SEVERITY = 'permanent';

/** The three escalation columns as stored on `publication-source`. */
export interface HttpLinksFeedState {
  http_links_first_seen_at?: Date | null;
  http_links_last_seen_at?: Date | null;
  http_links_day_count?: number | null;
}

export type HttpLinksAction = 'none' | 'reset' | 'record_day' | 'deactivate';

export interface HttpLinksDecision {
  action: HttpLinksAction;
  /** The day count AFTER this decision (unchanged for 'none', 0 for 'reset'). */
  dayCount: number;
  /** Value to persist for `http_links_first_seen_at` (null on reset). */
  firstSeenAt: Date | null;
  /** Value to persist for `http_links_last_seen_at` (null on reset). */
  lastSeenAt: Date | null;
  /** Short machine-ish explanation for logs. */
  reason: string;
}

/** UTC calendar day of a date, `YYYY-MM-DD`. The escalation's unit of time. */
export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Decide what one fetch's articles cost a feed on the http-links axis.
 *
 * The four branches, and why each exists:
 *
 *   NO EVIDENCE (`evaluatedArticles === 0`) → 'none'. A fetch that produced no
 *     article documents at all (quiet publisher, everything filtered out before
 *     a URL was ever classified) is not evidence of anything. Treating it as
 *     "clean" would reset a real offender every quiet hour; treating it as dirty
 *     would punish silence.
 *
 *   CLEAN (`insecureArticles === 0`) → 'reset', clearing all three columns. This
 *     is the "try again next day if they fixed it" half: a publisher that
 *     switches to https gets its slate wiped on the very next fetch, no matter
 *     how many days it had accumulated. 'none' when there was nothing to clear,
 *     so a healthy feed never generates a write.
 *
 *   SAME UTC DAY (`utcDayKey(last_seen) === utcDayKey(now)`) → 'none'. This is
 *     the "block for the day" half and the idempotency guard in one: a feed
 *     fetched hourly must cost at most ONE day, or the 7-day threshold would be
 *     reached in 7 hours. Idempotent across BullMQ retries for free, because the
 *     guard is a stored timestamp rather than a counter.
 *
 *   NEW DAY → count + 1, then 'deactivate' at the threshold else 'record_day'.
 *
 * Pure: the caller persists the returned values and performs the deactivation.
 */
export function decideHttpLinksEscalation(input: {
  state: HttpLinksFeedState;
  /** Articles from this fetch whose `article_url` landed `insecure`. */
  insecureArticles: number;
  /** Articles from this fetch whose URL was classified at all. */
  evaluatedArticles: number;
  now: Date;
  config: HttpLinksPolicyConfig;
}): HttpLinksDecision {
  const { state, insecureArticles, evaluatedArticles, now, config } = input;

  const storedCount = state.http_links_day_count ?? 0;
  const firstSeenAt = state.http_links_first_seen_at ?? null;
  const lastSeenAt = state.http_links_last_seen_at ?? null;

  if (evaluatedArticles === 0) {
    return {
      action: 'none',
      dayCount: storedCount,
      firstSeenAt,
      lastSeenAt,
      reason: 'no articles classified this fetch; no evidence either way',
    };
  }

  if (insecureArticles === 0) {
    const hadState =
      storedCount > 0 || firstSeenAt !== null || lastSeenAt !== null;
    return {
      action: hadState ? 'reset' : 'none',
      dayCount: 0,
      firstSeenAt: null,
      lastSeenAt: null,
      reason: hadState
        ? `all ${evaluatedArticles} article(s) secure or upgraded; escalation cleared`
        : `all ${evaluatedArticles} article(s) secure or upgraded`,
    };
  }

  if (lastSeenAt !== null && utcDayKey(lastSeenAt) === utcDayKey(now)) {
    return {
      action: 'none',
      dayCount: storedCount,
      firstSeenAt,
      lastSeenAt,
      reason: `already counted for UTC day ${utcDayKey(now)} (day ${storedCount})`,
    };
  }

  const dayCount = storedCount + 1;
  const nextFirstSeenAt = firstSeenAt ?? now;

  if (dayCount >= config.blockAfterDays) {
    return {
      action: 'deactivate',
      dayCount,
      firstSeenAt: nextFirstSeenAt,
      lastSeenAt: now,
      reason: `insecure article links on ${dayCount} separate days (threshold ${config.blockAfterDays})`,
    };
  }

  return {
    action: 'record_day',
    dayCount,
    firstSeenAt: nextFirstSeenAt,
    lastSeenAt: now,
    reason: `insecure article links on day ${dayCount} of ${config.blockAfterDays}`,
  };
}
