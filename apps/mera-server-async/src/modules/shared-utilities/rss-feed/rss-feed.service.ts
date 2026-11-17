import { Injectable, Logger } from '@nestjs/common';
import Parser from 'rss-parser';
import * as countries from 'i18n-iso-countries';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import { ProxyEgressUnavailableError } from '@mera/shared';
import { AxiosService } from '../axios/axios.service';
import { FeedFetchError } from './feed-fetch-error';

/**
 * Axios defaults to `Accept: application/json, text/plain, *\/*`, and feed
 * endpoints that content-negotiate return JSON for it — which then fails to
 * parse and is recorded as a dead feed. Measured on assembly.go.kr and
 * fsc.go.kr: JSON with the default header, valid RSS with this one.
 */
const FEED_ACCEPT =
  'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8';

export interface RssFeedItem {
  title?: string;
  contentSnippet?: string;
  description?: string;
  pubDate?: string;
  creator?: string;
  link?: string;
  enclosure?: {
    url?: string;
  };
  mediaThumbnail?: string | MediaCandidate | MediaCandidate[];
  mediaContent?: string | MediaCandidate | MediaCandidate[];
  [key: string]: any;
}

/**
 * A single `<media:thumbnail>` or `<media:content>` element as xml2js/
 * rss-parser hands it back with `keepArray: true`: always inside an array,
 * attributes under `$`, `width`/`height` as strings (XML has no numeric
 * type) — verified against a live multi-`<media:content>` parse. `url` and
 * `width`/`height` at the top level (no `$`) are kept in the type only for
 * defensiveness against a differently-configured parser; the real path never
 * produces them.
 */
export interface MediaCandidate {
  url?: string;
  width?: string;
  height?: string;
  $?: { url?: string; width?: string; height?: string };
}

@Injectable()
export class RSSFeedService {
  private readonly logger = new Logger(RSSFeedService.name);
  private readonly rssParser: Parser;

  constructor(private axiosService: AxiosService) {
    this.rssParser = new Parser({
      customFields: {
        // `keepArray: true` on both: a feed item can carry more than one
        // `<media:content>` (one per resolution) or `<media:thumbnail>`.
        // Without it, xml2js silently keeps only the LAST element on a
        // multi-element tag, which is not necessarily the best one — see
        // `selectImageUrl` in load-rss-feed.service.ts for how the array is
        // resolved down to a single URL.
        item: [
          ['dc:creator', 'creator'],
          ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
          ['media:content', 'mediaContent', { keepArray: true }],
        ],
      },
    });
  }

  /**
   * Fetch and parse RSS feed, return parsed items and feed metadata
   * @param publicationSource - PublicationSource document object containing feed information
   * @returns Object containing parsed items and feed metadata
   */
  async fetchRSSFeed(publicationSource: PublicationSource): Promise<{
    items: RssFeedItem[];
    /**
     * The origin answered 304 Not Modified. `items` is empty and NOTHING else
     * was parsed, because there is no body to parse. Callers MUST branch on
     * this before any per-item work; see the note on the short-circuit below.
     */
    notModified?: boolean;
    language_code?: string;
    publication_image_uri?: string;
    update_frequency?: string;
    update_period?: number;
    last_publish_date?: Date;
    /**
     * How the feed was fetched, for the caller to persist as feed health.
     * `via` is what the request ACTUALLY used, reported by AxiosService, not
     * what the `gated` flag predicted.
     */
    fetchMeta: {
      via: 'proxy' | 'direct';
      httpStatus?: number;
      gated: boolean;
      /** Validators to store verbatim for the next conditional GET. */
      etag?: string;
      lastModified?: string;
      /** Final URL when EVERY redirect hop was 301/308. Observation only. */
      resolvedFeedUrl?: string;
      /** Wire bytes from `content-length`; null when the response is chunked. */
      bytes: number | null;
      /** Post-decompression body size. Not what the proxy vendor bills. */
      decodedBytes: number;
      fetchMs: number;
    };
  }> {
    const feedUrl = publicationSource.feed_url;
    const isGated = publicationSource.gated === true;
    const startedAt = Date.now();

    // `via` starts at the flag's prediction and is CORRECTED by `onVia` below.
    // Reporting the prediction is what made a feed rescued by the direct
    // fallback record itself as 'proxy'.
    let via: 'proxy' | 'direct' = isGated ? 'direct' : 'proxy';
    /** Status of every redirect hop, for the 301/308-only rule. */
    const redirectStatuses: number[] = [];

    try {
      // Fetch RSS feed via proxy using AxiosService
      let response;

      try {
        // `validateStatus` is widened for 304 AND FOR NOTHING ELSE.
        //
        // Axios must keep rejecting on every other non-2xx so AxiosService's
        // retry loop sees the status and re-tries 403/429/5xx from a different
        // egress IP; a permissive validateStatus resolves the promise and
        // silently skips the whole PROXY_FETCH_RETRIES budget.
        //
        // 304 is the one status where that reasoning does not apply, because it
        // is a SUCCESS: the origin is telling us our cached copy is current. A
        // different egress IP cannot change that answer, so a retry would be
        // pure waste. Nothing else may ever be added here.
        const requestConfig = {
          method: 'GET',
          url: feedUrl,
          responseType: 'arraybuffer' as const,
          validateStatus: (status: number) =>
            (status >= 200 && status < 300) || status === 304,
          // Axios defaults to `Accept: application/json, ...`, and feed
          // endpoints that content-negotiate honour it and return JSON, which
          // then fails to parse. Ask for XML explicitly.
          //
          // Validators are sent RAW. Never re-format them: an origin comparing
          // If-Modified-Since as text misses on any re-serialisation, which
          // costs a full body download and is invisible to a test that only
          // checks the header was present.
          headers: {
            Accept: FEED_ACCEPT,
            ...(publicationSource.http_etag
              ? { 'If-None-Match': publicationSource.http_etag }
              : {}),
            ...(publicationSource.http_last_modified
              ? { 'If-Modified-Since': publicationSource.http_last_modified }
              : {}),
          },
          // follow-redirects hands the status of each hop here (axios wires a
          // caller-supplied beforeRedirect as `beforeRedirects.config`). We
          // need every hop, not just the last, because one temporary redirect
          // anywhere disqualifies the whole chain from updating a feed URL.
          beforeRedirect: (
            _options: unknown,
            responseDetails: { statusCode?: number },
          ): void => {
            if (typeof responseDetails?.statusCode === 'number') {
              redirectStatuses.push(responseDetails.statusCode);
            }
          },
        };

        if (isGated) {
          // `gated` means the audit proved this feed answers a direct request
          // but 403s through the proxy pool — government WAFs reject datacenter
          // ranges far more aggressively than newspapers do. Routing it through
          // the proxy anyway guarantees a 403 on every cycle until the
          // chronic-death rule deactivates it, so go direct. This is the path
          // publication-source.model.ts has always anticipated.
          //
          // `via` is already 'direct' and stays there: this is the PRIMARY
          // path, not a fallback, so there is no onVia to correct it.
          response = await this.axiosService.callWithoutProxy(requestConfig);
        } else {
          response = await this.axiosService.callUsingProxy(
            requestConfig,
            this.resolveProxyCountry(publicationSource),
            {
              // Deliberately TRUE, and not the `gated`-only rule the plan first
              // sketched. That rule assumed a proxy-infrastructure status would
              // open the pool breaker and thereby arm this fallback for the
              // whole catalogue; it does not, because 407 is not in
              // EGRESS_FAULT_STATUSES and a 407 is shed by the latch before it
              // ever reaches here. Passing false would instead disable the
              // PRE-EXISTING 403/5xx fallback, which is a different mechanism
              // and a real loss of feed availability.
              allowDirectFallback: true,
              onVia: (actual) => {
                via = actual;
              },
            },
          );
        }
      } catch (fetchError) {
        // SEAM 1 of 3. The pool-wide breaker is open: our egress failed, this
        // feed did not. It MUST NOT become a FeedFetchError — with no
        // `.response` it would fall through to `network`, classify as
        // `transient`, and increment consecutive_fetch_failures on every feed
        // in the catalogue at once, quarantining all of them for 1-6h. That is
        // strictly worse than the outage it would be reacting to.
        if (fetchError instanceof ProxyEgressUnavailableError) {
          throw fetchError;
        }

        // Handle network errors gracefully
        const error = fetchError as Error & {
          code?: string;
          response?: { status: number; statusText: string };
        };

        if (error.code === 'ECONNRESET') {
          throw new FeedFetchError(
            'network',
            `Connection reset while fetching RSS feed (proxy or network issue)`,
          );
        } else if (
          error.code === 'ETIMEDOUT' ||
          error.code === 'ECONNABORTED'
        ) {
          throw new FeedFetchError(
            'timeout',
            `Request timeout while fetching RSS feed`,
          );
        } else if (error.code === 'EPROTO') {
          throw new FeedFetchError(
            'network',
            `SSL/TLS protocol error while fetching RSS feed (proxy or certificate issue)`,
          );
        } else if (error.response) {
          throw new FeedFetchError(
            'http_status',
            `HTTP ${error.response.status}: ${error.response.statusText}`,
            error.response.status,
          );
        } else {
          const message =
            error instanceof Error ? error.message : String(error);
          throw new FeedFetchError('network', `Network error: ${message}`);
        }
      }

      // ── 304 SHORT-CIRCUIT. THIS MUST STAY ABOVE THE STATUS GUARD. ─────────
      //
      // One line lower and 304 becomes `>= 300`, so the guard throws
      // FeedFetchError('http_status', …, 304). classifyFeedFailure then finds
      // 304 in neither PERMANENT_STATUSES nor BLOCKED_STATUSES, and its
      // `httpStatus >= 400` test is FALSE, so it falls through to 'transient'.
      // That increments consecutive_fetch_failures and writes a
      // fetch_outcome:'failure' history row.
      //
      // Once conditional GET works, 304 is the MAJORITY response. Every feed
      // would cross backoffStartFailures (3) within three hours and be
      // quarantined for 60-360m, and the unbroken run of recorded failures with
      // zero successes would then make isChronicallyDead start DEACTIVATING
      // feeds after 7 days. The optimisation would take the catalogue down more
      // thoroughly than the bandwidth problem it was fixing.
      //
      // Returning `notModified` rather than an empty-items success is equally
      // load-bearing: with no last_publish_date, getSkipReasonIfUnchanged
      // returns null ("can't compare, proceed"), so the caller would run
      // language detection over zero items and write feed_language_code: null
      // on every feed, every hour.
      if (response.status === 304) {
        return {
          items: [],
          notModified: true,
          fetchMeta: this.buildFetchMeta(
            response,
            via,
            isGated,
            startedAt,
            redirectStatuses,
          ),
        };
      }

      // Validate HTTP status after successful connection
      if (response.status < 200 || response.status >= 300) {
        throw new FeedFetchError(
          'http_status',
          `HTTP ${response.status}: ${response.statusText || 'Request failed'}`,
          response.status,
        );
      }

      if (!response.data) {
        throw new FeedFetchError(
          'empty_response',
          'RSS feed URL returned empty response',
        );
      }

      // Decode response bytes using the correct charset
      const rawBuffer = Buffer.from(response.data as ArrayBuffer);
      const contentType = response.headers?.['content-type'] as
        | string
        | undefined;
      const encoding = this.detectEncoding(contentType, rawBuffer);
      const decodedXml = this.decodeBuffer(rawBuffer, encoding);

      // Parse RSS feed XML to JSON
      let feed;
      try {
        feed = await this.rssParser.parseString(decodedXml);
      } catch (parseError) {
        const message =
          parseError instanceof Error ? parseError.message : String(parseError);
        throw new FeedFetchError(
          'parse_error',
          `Failed to parse RSS feed as valid XML: ${message}`,
        );
      }

      if (!feed || !feed.items || feed.items.length === 0) {
        throw new FeedFetchError(
          'empty_feed',
          'RSS feed does not contain any items',
        );
      }

      // Extract feed-level metadata (preserve original RSS language code, detection happens in load-rss-feed)
      const language_code = (feed.language as string | undefined)?.trim();

      const publication_image_uri = feed.image?.url;
      const update_frequency = feed.ttl ? 'minutely' : 'hourly'; // TTL is in minutes
      const update_period = feed.ttl ? parseInt(feed.ttl as string, 10) : 1;

      // Get the most recent publication date from items.
      // The NaN guard is load-bearing: an unparseable `pubDate` yields an
      // Invalid Date whose getTime() is NaN, Math.max(..., NaN) is NaN, and
      // `new Date(NaN)` is an Invalid Date that Mongoose then rejects with
      // `Cast to date failed for value "Invalid Date"`. That failed the WHOLE
      // job even though the fetch and the parse had both succeeded — one bad
      // item discarded every good one (75 occurrences in 3h of prod logs,
      // 2026-08-11, e.g. اليوم السابع).
      let last_publish_date: Date | undefined;
      if (feed.items.length > 0) {
        const dates = (feed.items as RssFeedItem[])
          .map((item) => (item.pubDate ? new Date(item.pubDate) : null))
          .filter(
            (date): date is Date =>
              date !== null && !Number.isNaN(date.getTime()),
          );

        if (dates.length > 0) {
          last_publish_date = new Date(
            Math.max(...dates.map((d) => d.getTime())),
          );
        }
      }

      return {
        items: feed.items as RssFeedItem[],
        language_code,
        publication_image_uri,
        update_frequency,
        update_period,
        last_publish_date,
        fetchMeta: this.buildFetchMeta(
          response,
          via,
          isGated,
          startedAt,
          redirectStatuses,
        ),
      };
    } catch (error) {
      // A shed caused by our own open circuit is not a property of this feed,
      // and there would be one line per feed in the catalogue on every tick.
      // The single `proxy_egress_open` line already carries that signal, and
      // the caller records the shed on the feed's own `consecutive_shed_cycles`
      // so a shed that never stops is still visible in the database.
      if (error instanceof ProxyEgressUnavailableError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      // Use warn instead of error - RSS fetch failures are expected operational issues
      // (blocked feeds, timeouts, network issues) not bugs
      this.logger.warn(
        `Failed to fetch RSS feed ${publicationSource.publication_name} (${feedUrl}): ${message}`,
      );
      throw error;
    }
  }

  /**
   * Assemble the feed-health / bandwidth metadata for one fetch.
   *
   * Shared by the 304 short-circuit and the normal success return so the two
   * cannot drift; a 304 that reported different provenance than a 200 would
   * quietly corrupt the direct-promotion evidence.
   */
  private buildFetchMeta(
    response: {
      status: number;
      data?: unknown;
      headers?: Record<string, unknown>;
      request?: { res?: { responseUrl?: string } };
    },
    via: 'proxy' | 'direct',
    isGated: boolean,
    startedAt: number,
    redirectStatuses: number[],
  ): {
    via: 'proxy' | 'direct';
    httpStatus?: number;
    gated: boolean;
    etag?: string;
    lastModified?: string;
    resolvedFeedUrl?: string;
    bytes: number | null;
    decodedBytes: number;
    fetchMs: number;
  } {
    const header = (name: string): string | undefined => {
      const raw = response.headers?.[name];
      return typeof raw === 'string' ? raw : undefined;
    };

    // `content-length` is the WIRE size, and it survives decompression because
    // axios deletes only `content-encoding`. It is what the proxy vendor bills.
    // Absent on a chunked response, which is why this is nullable rather than 0.
    const contentLength = header('content-length');
    const parsedLength = contentLength ? parseInt(contentLength, 10) : NaN;

    // Decompressed size. Axios advertises Accept-Encoding by default and
    // inflates transparently even under responseType 'arraybuffer', so this is
    // 3-5x the wire figure on RSS XML. Reported separately, never as `bytes`.
    const data = response.data;
    const decodedBytes =
      data instanceof ArrayBuffer
        ? data.byteLength
        : Buffer.isBuffer(data)
          ? data.byteLength
          : 0;

    // Only an ALL-301/308 chain may be treated as the feed having moved. One
    // 302 or 307 anywhere means the origin explicitly said "not permanent".
    const permanentChain =
      redirectStatuses.length > 0 &&
      redirectStatuses.every((s) => s === 301 || s === 308);
    const finalUrl = response.request?.res?.responseUrl;

    return {
      via,
      httpStatus: response.status,
      gated: isGated,
      etag: header('etag'),
      lastModified: header('last-modified'),
      resolvedFeedUrl: permanentChain ? finalUrl : undefined,
      bytes: Number.isNaN(parsedLength) ? null : parsedLength,
      decodedBytes,
      fetchMs: Date.now() - startedAt,
    };
  }

  /**
   * Map the source's alpha-3 country_code to a lowercase alpha-2 for geo-matched
   * proxy fetching; GLOBAL/missing/unmappable codes stay on the global pool.
   */
  private resolveProxyCountry(
    publicationSource: PublicationSource,
  ): string | undefined {
    const alpha3 = publicationSource.country_code;
    if (!alpha3) {
      return undefined;
    }
    return countries.alpha3ToAlpha2(alpha3)?.toLowerCase();
  }

  /**
   * Detect character encoding from HTTP Content-Type header or XML declaration.
   * Priority: Content-Type charset > XML encoding attribute > UTF-8 default.
   */
  private detectEncoding(
    contentTypeHeader: string | undefined,
    rawBytes: Buffer,
  ): string {
    if (contentTypeHeader) {
      const charsetMatch = contentTypeHeader.match(
        /charset\s*=\s*["']?([^\s;"']+)/i,
      );
      if (charsetMatch) {
        return charsetMatch[1].toLowerCase();
      }
    }

    // XML declaration is always ASCII-safe, so read first 200 bytes as ASCII
    const xmlHead = rawBytes.subarray(0, 200).toString('ascii');
    const encodingMatch = xmlHead.match(
      /<\?xml[^>]+encoding\s*=\s*["']([^"']+)["']/i,
    );
    if (encodingMatch) {
      return encodingMatch[1].toLowerCase();
    }

    return 'utf-8';
  }

  /**
   * Decode a raw buffer using the detected encoding.
   * Falls back to UTF-8 if the encoding is not supported by TextDecoder.
   */
  private decodeBuffer(buffer: Buffer, detectedEncoding: string): string {
    const encodingAliases: Record<string, string> = {
      'latin-1': 'iso-8859-1',
      latin1: 'iso-8859-1',
      cp1252: 'windows-1252',
      ascii: 'utf-8',
      'us-ascii': 'utf-8',
    };

    const encoding = encodingAliases[detectedEncoding] || detectedEncoding;

    try {
      return new TextDecoder(encoding).decode(buffer);
    } catch {
      this.logger.warn(
        `Unsupported encoding "${detectedEncoding}", falling back to UTF-8`,
      );
      return new TextDecoder('utf-8').decode(buffer);
    }
  }
}
