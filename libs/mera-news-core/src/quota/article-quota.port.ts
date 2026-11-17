/**
 * The article-delivery quota port.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `ArticlesForTopicsService` is the news retrieval + hydration pipeline. It is
 * shared by two apps with two completely different trust boundaries:
 *
 *   apps/mera-server-graphql    the app-facing API. A real user session is
 *                               present, so delivery is METERED against that
 *                               user's daily cap.
 *   apps/mera-server-news-api   the internal, service-to-service news relay.
 *                               There is NO user — the caller is another
 *                               service, and by design it cannot send a user
 *                               identity. Metering here is meaningless, and
 *                               quota is enforced by the caller instead.
 *
 * The pipeline itself must not know which of those it is running under, and it
 * must not reach a user collection to find out. So the quota is an injected
 * port: the metered app binds an adapter over `UserBillingService`, the
 * internal app binds `NoopArticleQuota`.
 *
 * That indirection is also what makes the credential lockdown possible. A
 * service bound to `NoopArticleQuota` touches no `userId`-keyed collection on
 * this path at all, so it can run with a database credential that has no access
 * to the user collections whatsoever.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. **Neither method throws.** `incrementStoryCount` is telemetry and must
 *    swallow its own failures; `reserve` reports refusal through
 *    `limitReached`, never through an exception. A quota backend that is down
 *    must not turn into a 500 on a feed request.
 *
 * 2. **`reserve` may grant PARTIALLY, and the caller relies on it.** It returns
 *    how many of the requested articles may be delivered NOW, which is
 *    `min(remaining, requested)` in the metered implementation. A request that
 *    straddles the ceiling is clipped and still carries articles; the caller
 *    slices `articleIds` by `granted` in REQUEST ORDER, so whatever the client
 *    asked for first is what spends the cap. `limitReached` is the signal that
 *    the clip happened — it is not inferable from `granted` alone.
 *
 * 3. **`resetAt` is always populated**, even when nothing was refused. It feeds
 *    a non-null-adjacent GraphQL field and a `null` here becomes a client-side
 *    "quota resets at Invalid Date".
 */

/** DI token for {@link ArticleQuotaPort}. */
export const ARTICLE_QUOTA = Symbol('ARTICLE_QUOTA');

/** Outcome of a single reservation attempt. */
export interface QuotaReservation {
  /** How many of the requested articles the user may receive now (≤ requested). */
  granted: number;
  /**
   * True when the cap clipped the request — `granted < requested`. NOT the
   * same as `granted === 0`: a request that straddled the ceiling is clipped
   * and still carried articles. It means "there is nothing more today", so
   * the client should stop polling until `resetAt`.
   */
  limitReached: boolean;
  /** Next 00:00 UTC — when the window refreshes. Never null; see contract 3. */
  resetAt: Date;
}

export interface ArticleQuotaPort {
  /**
   * Reserve `count` articles against the caller's daily cap before they are
   * hydrated. See contract 2: the grant may be partial.
   *
   * `now` and `userCreatedAt` are OPTIONAL and come LAST, in that order,
   * because the metered implementation defaults `now` and every existing
   * caller and spec passes `(userId, count)` or `(userId, count, now)`
   * positionally. Neither is padding: `userCreatedAt` is what the metered side
   * feeds to the promo-grant window, so an implementation that drops it
   * silently withdraws that elevation from accounts inside the window — a
   * wrong cap, never an error. An unmetered implementation ignores both.
   */
  reserve(
    userId: string,
    count: number,
    now?: Date,
    userCreatedAt?: unknown,
  ): Promise<QuotaReservation>;

  /**
   * Record articles delivered through the quota-EXEMPT followed-story path.
   *
   * TELEMETRY ONLY. It gates nothing, refuses nothing and refunds nothing — it
   * exists so the exemption is observable. Verifying "followed-story articles
   * stopped counting" against the metered tally alone is not a real test: a
   * number that fails to move cannot distinguish "the exemption worked" from
   * "the sync delivered nothing". A counter that goes UP can.
   */
  incrementStoryCount(userId: string, count: number): Promise<void>;
}
