import { Injectable } from '@nestjs/common';
import type { ArticleQuotaPort, QuotaReservation } from './article-quota.port';

/**
 * The `ArticleQuotaPort` binding for a service with no user to meter.
 *
 * Used by `apps/mera-server-news-api`, the internal service-to-service news
 * relay. Its caller owns all user data and enforces the quota
 * itself; this side has no user identity to charge and must not acquire one.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * `granted` MUST ECHO `count`, AND `limitReached` MUST BE `false`
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * These are not arbitrary "empty" values — each one is load-bearing, and the
 * obvious zero-ish choice is wrong in a way that fails silently:
 *
 *   granted: 0        the caller slices `articleIds.slice(0, granted)`, so a 0
 *                     hydrates NOTHING and returns an empty article list.
 *                     No error, no warning — just an empty feed.
 *
 *   limitReached: true `ArticlesForTopicsByIdsResponse.dailyLimitReached` is
 *                     `Boolean!` in the schema, and the client treats `true` as
 *                     "you have hit your cap", showing a paywall/limit notice
 *                     to a user who has no cap on this path at all.
 *
 *   resetAt           left absent on purpose. The response type documents it as
 *                     "set only when dailyLimitReached is true", and since
 *                     nothing is ever limited here it must never be populated.
 *                     The `resetAt` returned below is part of the PORT's
 *                     contract (never null — see `article-quota.port.ts`
 *                     contract 3); the caller drops it because `limitReached`
 *                     is false. Returning a real timestamp here keeps the port
 *                     honest without leaking anything into the response.
 *
 * This mirrors the shape `articlesForStories` already returns on the
 * app-facing API — the established in-repo answer for "hydrate these, charge
 * nothing": `dailyLimitReached: false`, `resetAt` absent.
 */
@Injectable()
export class NoopArticleQuota implements ArticleQuotaPort {
  /**
   * Grants everything asked for, always.
   *
   * `count` is echoed rather than clamped: the caller uses it as a slice bound,
   * so any smaller number silently truncates the delivery.
   */
  async reserve(
    userId: string,
    count: number,
    now?: Date,
    userCreatedAt?: unknown,
  ): Promise<QuotaReservation> {
    void userId; // no user to meter on this path — deliberately unused.
    void userCreatedAt; // no cap to elevate, so the grant window is irrelevant.
    return {
      granted: Math.max(0, count),
      limitReached: false,
      resetAt: nextUtcMidnight(now ?? new Date()),
    };
  }

  /** No tally exists to increment. Deliberately does nothing, never throws. */
  async incrementStoryCount(userId: string, count: number): Promise<void> {
    void userId;
    void count;
  }
}

/**
 * First instant of the next UTC day. Duplicated from `UserBillingService`
 * rather than shared: that helper lives in the app alongside the user
 * collections this lib must never reach, and a three-line date calculation is
 * not worth a dependency that points the wrong way.
 */
function nextUtcMidnight(now: Date): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ),
  );
}
