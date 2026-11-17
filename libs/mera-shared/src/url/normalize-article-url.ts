/**
 * Canonical article-URL handling, shared by the insecure-URL policy and the
 * fact-check cache.
 *
 * WHY THIS IS SHARED: the insecure-URL work rewrites an article's `article_url`
 * from `http://` to `https://` when the https variant resolves. The fact-check
 * cache is keyed on the article URL. If each computed its own key, the SAME
 * article would produce two different fact-check rows either side of that
 * upgrade — the cache would silently miss and we would pay Gemini twice for an
 * answer we already had. `ArticleFingerprint.article_url` (a unique index) has
 * the same exposure.
 *
 * TWO FUNCTIONS, DELIBERATELY:
 *
 *   normalizeArticleUrl() — the canonical, USER-FACING url. Safe to store in
 *     `article_url` and safe to open in a browser. Conservative: it only removes
 *     things that cannot change which page you land on.
 *
 *   articleUrlKey() — a cache/dedupe KEY. Additionally sorts query parameters
 *     and lowercases the whole string. Never show this to a user and never
 *     navigate to it: parameter order is meaningless for identity but a handful
 *     of sites do care, and lowercasing a path breaks case-sensitive servers.
 *
 * Keeping them separate is the point. A single function that did both would
 * either give a weak cache key or hand users a URL we had quietly mangled.
 *
 * Pure and dependency-free — imported by scripts, the ingest pipeline, and the
 * GraphQL layer alike.
 */

/**
 * Query parameters that identify a *referrer*, never a *page*. Dropping them is
 * what makes a shared link and the original link the same article.
 *
 * Exact names only, plus the `utm_` prefix. Deliberately conservative: `ref`,
 * `source` and `id` are NOT here, because plenty of publishers route real
 * article identity through them and dropping one would merge two distinct
 * articles into a single cache entry — a far worse failure than a cache miss.
 */
const TRACKING_PARAM_PREFIXES = ['utm_'] as const;
const TRACKING_PARAM_NAMES = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'twclid',
  'ttclid',
  '_ga',
  'yclid',
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    TRACKING_PARAM_NAMES.has(lower) ||
    TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

/**
 * Parse `raw` into a URL, tolerating the two shapes RSS feeds actually emit
 * that `new URL()` rejects: a protocol-relative `//host/path` and a bare
 * `host/path`. Returns null when there is nothing usable.
 */
function parse(raw: string): URL | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : trimmed.startsWith('//')
      ? `https:${trimmed}`
      : `https://${trimmed}`;

  try {
    const url = new URL(candidate);
    // Anything that isn't web content (mailto:, javascript:, data:, ftp:) is
    // not an article. Refusing here keeps callers from having to re-check.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // No empty-host guard: for special schemes WHATWG either throws
    // (`https://`) or promotes the next segment to the host (`https:///path`
    // parses as host `path`), so an http/https URL can never reach here with
    // an empty hostname.
    return url;
  } catch {
    return null;
  }
}

/**
 * Canonical, user-facing form of an article URL.
 *
 * Applies, in order: force `https`, lowercase the host, drop a leading `www.`,
 * drop the default port, drop tracking parameters, drop the fragment, and drop
 * a trailing slash from a non-root path.
 *
 * Returns the trimmed input unchanged when it cannot be parsed. It never throws
 * and never returns an empty string for a non-empty input — a caller storing
 * this into `article_url` must not be handed `undefined` for a URL that is
 * merely unusual.
 *
 * NOTE the https forcing: this function alone does NOT make a URL safe. It only
 * makes the http and https forms of one article compare equal. Whether the
 * https variant actually resolves is a network question answered by the ingest
 * probe, and only that probe may promote an article's stored URL.
 */
function canonicalize(url: URL): void {
  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  url.port = '';
  url.hash = '';
  url.username = '';
  url.password = '';

  for (const name of [...url.searchParams.keys()]) {
    if (isTrackingParam(name)) url.searchParams.delete(name);
  }
}

function render(url: URL): string {
  // No trailing-`?` cleanup needed: `URL.toString()` omits the `?` entirely
  // once `search` is empty, whether it was cleared or its last param deleted.
  const out = url.toString();

  // Trailing slash on a real path is noise; on the root it is canonical.
  return url.pathname !== '/' && url.search === ''
    ? out.replace(/\/$/, '')
    : out;
}

export function normalizeArticleUrl(raw: string): string {
  const url = parse(raw);
  if (url === null) return raw.trim();

  canonicalize(url);
  return render(url);
}

/**
 * Stable identity key for an article URL. Use for cache keys, dedupe and
 * hashing — never for storage or navigation.
 *
 * Everything `normalizeArticleUrl` does, plus: query parameters sorted by name
 * (order carries no identity but varies between feeds), and the whole string
 * lowercased (some feeds vary path casing for the same article).
 */
export function articleUrlKey(raw: string): string {
  const url = parse(raw);
  if (url === null) return raw.trim().toLowerCase();

  canonicalize(url);

  // Parameter order carries no identity but varies between feeds.
  const params = [...url.searchParams.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  url.search = '';
  for (const [name, value] of params) url.searchParams.append(name, value);

  return render(url).toLowerCase();
}

/** Is this URL served over plain http? The insecure-URL policy's entry point. */
export function isInsecureUrl(raw: string): boolean {
  return /^http:\/\//i.test(raw.trim());
}

/**
 * The https twin of an http URL, for the ingest upgrade probe. Returns null
 * when `raw` is not http (nothing to upgrade).
 *
 * Deliberately a minimal scheme swap rather than `normalizeArticleUrl` — the
 * probe must request the exact URL the publisher published, or a 404 from our
 * own tidying reads as "https is unavailable" and needlessly blocks an article.
 */
export function httpsVariant(raw: string): string | null {
  const trimmed = raw.trim();
  if (!isInsecureUrl(trimmed)) return null;
  return `https://${trimmed.slice('http://'.length)}`;
}
