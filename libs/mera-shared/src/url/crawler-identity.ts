/**
 * How this system identifies itself to the publishers it fetches from.
 *
 * ONE DEFINITION, DELIBERATELY. There are two independent fetchers in this
 * repo: the hourly RSS path (AxiosService, mera-server-async) and the audit
 * tool (FeedValidatorService, mera-scripts), which does NOT go through
 * RSSFeedService and has its own HTTP client. A publisher who allowlists our
 * declared User-Agent and then sees a different one arrive during an audit
 * learns that our identification is unreliable, which is the opposite of what
 * declaring it is for. Two literals would drift silently and the drift would
 * only surface as a publisher complaint, so there is one constant and both
 * call sites import it.
 *
 * A THIRD COPY LIVES OUTSIDE THIS REPO, in the promo site's /bot page, inside a
 * copy-paste block offered for firewall and CDN rules. That one cannot import
 * this, so it is pinned by an exact-bytes assertion on each side. Changing the
 * string means changing both repos together.
 *
 * On the placement: this sits under `url/` because that is where this library
 * keeps its HTTP-and-URL-adjacent shared concerns (normalize-article-url,
 * url-security) and because both importers can reach it. It is not a URL, and
 * that is the only reason the file has its own name rather than joining one of
 * those.
 */

/**
 * The identifying User-Agent for every outbound fetch this system makes.
 *
 * It replaced `Mozilla/5.0 (compatible; MeraNewsBot/1.0)`. Claiming to be a
 * browser while behaving nothing like one is among the strongest bot signals a
 * WAF scores against you, and it left a publisher who wanted to rate-limit us
 * no option except an outright block. The `Bot/version (+url)` form is what WAF
 * vendors recognise as a declared crawler, and the URL is a route to contact us
 * instead of blocking us.
 *
 * Never the default here: the fetcher this string names sets it through
 * FEED_FETCH_USER_AGENT, and every other install defaults to
 * DEFAULT_FEED_USER_AGENT, so a publisher's rules for that fetcher never apply
 * to anyone else's install.
 *
 * FROZEN. Exact bytes, including the single space before the parenthesis, the
 * lowercase path and the absent trailing slash.
 */
export const CRAWLER_USER_AGENT = 'MeraNewsBot/1.0 (+https://mera.news/bot)';

/** What a self-hosted install sends when FEED_FETCH_USER_AGENT is unset. */
export const DEFAULT_FEED_USER_AGENT = 'mera-news-data-server (self-hosted)';
