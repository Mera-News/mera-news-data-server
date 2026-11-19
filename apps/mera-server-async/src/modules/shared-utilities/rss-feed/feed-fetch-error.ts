/**
 * Categorized RSS feed fetch failure. Thrown by RSSFeedService.fetchRSSFeed so
 * callers can persist feed health (last_fetch_status / last_fetch_http_status)
 * without brittle message-string parsing. The `.message` stays human-readable —
 * it is reused verbatim for the StateMachineFetchPublication errorMessage and the
 * Bull Board error view.
 */
/**
 * `empty_feed` and `empty_response` are deliberately distinct:
 * - `empty_response` — HTTP 2xx with no body at all. Suspicious; treated as a
 *   transient fetch failure.
 * - `empty_feed` — the feed parsed fine and simply has zero <item>s right now.
 *   That is a publisher being quiet, not a broken feed, so the failure policy
 *   classifies it as benign and it never counts toward deactivation.
 */
export type FeedFetchCategory =
  | 'http_status'
  | 'timeout'
  | 'network'
  | 'parse_error'
  | 'empty_response'
  | 'empty_feed'
  // The address is not one the fetcher may connect to. Only the operator's
  // FEED_FETCH_ALLOW_HOSTS can change that.
  | 'refused';

export class FeedFetchError extends Error {
  constructor(
    public readonly category: FeedFetchCategory,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'FeedFetchError';
    // Restore prototype chain for `instanceof` across the TS→ES5/ES2017 downlevel.
    Object.setPrototypeOf(this, FeedFetchError.prototype);
  }
}
