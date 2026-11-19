/**
 * The ingest half of the insecure-URL policy: given the raw URLs an RSS item
 * published, decide what to store and what state to stamp.
 *
 * "Upgrade & block for the day":
 *   UPGRADE — an http URL whose https twin actually answers is rewritten to
 *     https and stamped `upgraded`. `httpsVariant()` is a minimal scheme swap on
 *     purpose (see its doc): the probe must request exactly what the publisher
 *     published, or a 404 caused by our own tidying reads as "https unavailable"
 *     and needlessly blocks a fine article.
 *   BLOCK FOR THE DAY — the verdict is cached PER HOST for 24h. The 3,912 http
 *     articles of a large catalogue span a far smaller set of hosts, so per-host caching
 *     turns thousands of network probes into dozens, and the 24h TTL is what
 *     makes "try again next day if they fixed it" cost nothing.
 *
 * The per-host verdict is "this host answered our https request", probed with a
 * real URL that host published. It is deliberately coarser than per-URL: a
 * per-URL probe would be ~1 network round trip per http article, which is the
 * cost this cache exists to avoid. The 24h TTL bounds how long a wrong verdict
 * can persist.
 *
 * IMAGES suppress, they do not block. An un-upgradable http `image_url` is
 * nulled at ingest so no serving path can emit it, and the article itself is
 * still served. "No image" is a shape every path already handles (`image_url`
 * is nullable everywhere). Image outcomes NEVER feed the per-feed escalation —
 * only `article_url` does.
 *
 * FAILURE IS ALWAYS "https unavailable". Every error inside the probe degrades
 * to a negative verdict; nothing here may throw into the fetch job, because a
 * DNS hiccup must not fail a feed's whole ingest.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';
import { isInsecureUrl, httpsVariant } from '@mera/shared';
import { UrlSecurityState } from '@mera/shared/url/url-security';
import { scrubUrlsInText } from '@mera/shared/url/strip-url-secrets';

/** The subset of a `fetch` Response the probe reads. */
export interface ProbeResponse {
  ok: boolean;
  status: number;
  /** Final URL after redirects — how we catch an https -> http bounce. */
  url: string;
}

export type ProbeFetch = (
  url: string,
  init: {
    method: string;
    redirect: 'follow';
    signal: AbortSignal;
    headers?: Record<string, string>;
  },
) => Promise<ProbeResponse>;

/** DI token for the fetch implementation, so tests inject a stub. */
export const HTTPS_PROBE_FETCH = 'HTTPS_PROBE_FETCH';

/** One RSS item's raw URLs, before any rewriting. */
export interface RawUrls {
  articleUrl: string;
  imageUrl?: string;
}

export interface UrlSecurityResolution {
  /** URL to STORE in `article_url` (https when upgraded, else as published). */
  articleUrl: string;
  /**
   * The URL as published. Kept because the 90-day `article-fingerprint` ledger
   * holds the PRE-upgrade form from earlier polls — deduping only on the
   * rewritten URL would let every republished http article re-enter as new.
   */
  rawArticleUrl: string;
  /**
   * State to stamp, or `undefined` when the probe is disabled and the URL is
   * http. Undefined means "never evaluated" and stays servable — see the
   * `url_security_state` prop doc.
   */
  state?: UrlSecurityState;
  /** URL to store in `image_url`; `undefined` when suppressed. */
  imageUrl?: string;
}

/** Per-attempt budget. Two attempts (HEAD, then ranged GET) worst case. */
const PROBE_TIMEOUT_MS = 2000;
/** Distinct hosts probed in parallel. Bounds a feed with many image CDNs. */
const PROBE_CONCURRENCY = 6;
/** 24h — the "block for the day" half of the policy. */
const HOST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class UrlSecurityProbeService {
  private readonly logger = new Logger(UrlSecurityProbeService.name);
  private readonly enabled: boolean;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly configService: ConfigService,
    @Inject(HTTPS_PROBE_FETCH) private readonly fetchImpl: ProbeFetch,
  ) {
    // Default TRUE: the policy is on unless someone deliberately switches it
    // off. Only the exact string 'false' disables, so a typo cannot silently
    // turn the feature off.
    this.enabled =
      String(
        this.configService?.get<string>('HTTP_UPGRADE_PROBE_ENABLED', 'true') ??
          'true',
      ) !== 'false';
  }

  /** Is the ingest probe switched on? Drives whether escalation may run. */
  get probeEnabled(): boolean {
    return this.enabled;
  }

  private static hostCacheKey(host: string): string {
    return `httpsup:${host}`;
  }

  /** Lowercased host (incl. port) of a URL, or null when unparseable. */
  private static hostOf(raw: string): string | null {
    try {
      return new URL(raw.trim()).host.toLowerCase() || null;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a whole fetch's worth of URLs in one pass.
   *
   * Host-dedupes FIRST, then probes distinct hosts with a small concurrency
   * cap. Article URLs are usually the feed's own host (one probe), but image
   * CDNs are not — a feed with 20 distinct image hosts probed serially at 2s
   * each would eat the 2-minute fetch job budget on its own.
   */
  async resolveBatch(items: RawUrls[]): Promise<UrlSecurityResolution[]> {
    // Switched off: a true revert to the pre-policy behaviour. No probes, no
    // rewrites, no image suppression, and http articles are left UNSTAMPED
    // (absent => servable) rather than marked insecure. Marking them insecure
    // would make `upgraded` unreachable and quietly arm the 7-day permanent
    // block on every http-emitting feed — an irreversible consequence nobody
    // flipping a switch named "disable probe" would expect.
    if (!this.enabled) {
      return items.map((item) => ({
        articleUrl: item.articleUrl,
        rawArticleUrl: item.articleUrl,
        state: isInsecureUrl(item.articleUrl)
          ? undefined
          : UrlSecurityState.SECURE,
        imageUrl: item.imageUrl,
      }));
    }

    const hosts = new Set<string>();
    for (const item of items) {
      for (const raw of [item.articleUrl, item.imageUrl]) {
        if (!raw || !isInsecureUrl(raw)) continue;
        const host = UrlSecurityProbeService.hostOf(raw);
        if (host) hosts.add(host);
      }
    }

    const verdicts = await this.probeHosts(items, hosts);

    return items.map((item) => {
      const articleHost = isInsecureUrl(item.articleUrl)
        ? UrlSecurityProbeService.hostOf(item.articleUrl)
        : null;

      let articleUrl = item.articleUrl;
      let state: UrlSecurityState | undefined = UrlSecurityState.SECURE;
      if (isInsecureUrl(item.articleUrl)) {
        const upgraded =
          articleHost !== null && verdicts.get(articleHost) === true
            ? httpsVariant(item.articleUrl)
            : null;
        if (upgraded) {
          articleUrl = upgraded;
          state = UrlSecurityState.UPGRADED;
        } else {
          state = UrlSecurityState.INSECURE;
        }
      }

      let imageUrl = item.imageUrl;
      if (imageUrl && isInsecureUrl(imageUrl)) {
        const imageHost = UrlSecurityProbeService.hostOf(imageUrl);
        const upgraded =
          imageHost !== null && verdicts.get(imageHost) === true
            ? httpsVariant(imageUrl)
            : null;
        // Suppress, don't block: an un-upgradable image is dropped and the
        // article is served without one.
        imageUrl = upgraded ?? undefined;
      }

      return {
        articleUrl,
        rawArticleUrl: item.articleUrl,
        state,
        imageUrl,
      };
    });
  }

  /**
   * Resolve every distinct host to a boolean verdict, reading the 24h Redis
   * cache first and probing only the misses (bounded concurrency).
   */
  private async probeHosts(
    items: RawUrls[],
    hosts: Set<string>,
  ): Promise<Map<string, boolean>> {
    const verdicts = new Map<string, boolean>();
    if (hosts.size === 0) return verdicts;

    // A published URL per host, so the probe requests something real.
    const sampleByHost = new Map<string, string>();
    for (const item of items) {
      for (const raw of [item.articleUrl, item.imageUrl]) {
        if (!raw || !isInsecureUrl(raw)) continue;
        const host = UrlSecurityProbeService.hostOf(raw);
        if (host && !sampleByHost.has(host)) sampleByHost.set(host, raw);
      }
    }

    const toProbe: string[] = [];
    for (const host of hosts) {
      const cached = await this.readHostCache(host);
      if (cached === null) toProbe.push(host);
      else verdicts.set(host, cached);
    }

    const queue = [...toProbe];
    const worker = async (): Promise<void> => {
      let host: string | undefined;
      while ((host = queue.shift())) {
        const sample = sampleByHost.get(host);
        const supported = sample ? await this.probeHost(sample) : false;
        verdicts.set(host, supported);
        await this.writeHostCache(host, supported);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, toProbe.length) }, () =>
        worker(),
      ),
    );

    return verdicts;
  }

  private async readHostCache(host: string): Promise<boolean | null> {
    try {
      const cached = await this.cacheManager.get<string>(
        UrlSecurityProbeService.hostCacheKey(host),
      );
      if (cached === '1') return true;
      if (cached === '0') return false;
      return null;
    } catch {
      // A cache outage must degrade to "probe it", never to a wrong verdict.
      return null;
    }
  }

  private async writeHostCache(host: string, value: boolean): Promise<void> {
    try {
      await this.cacheManager.set(
        UrlSecurityProbeService.hostCacheKey(host),
        value ? '1' : '0',
        HOST_CACHE_TTL_MS,
      );
    } catch {
      // Losing the cache write only costs a repeat probe.
    }
  }

  /**
   * Does the https twin of `rawHttpUrl` actually answer? HEAD first (cheapest),
   * falling back to a 1-byte ranged GET because plenty of origins and CDNs
   * reject HEAD outright while serving GET fine.
   */
  private async probeHost(rawHttpUrl: string): Promise<boolean> {
    const target = httpsVariant(rawHttpUrl);
    if (!target) return false;

    if (await this.attempt(target, 'HEAD')) return true;
    return this.attempt(target, 'GET', { Range: 'bytes=0-0' });
  }

  private async attempt(
    url: string,
    method: string,
    headers?: Record<string, string>,
  ): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers,
      });
      if (!response?.ok) return false;
      // A 301 from https to http is NOT an upgrade — the reader still ends up
      // on a plaintext page. Only a response that is still https counts.
      const finalUrl = response.url ?? url;
      return /^https:\/\//i.test(finalUrl);
    } catch (err) {
      // The host only: an address can carry a credential in its path or query.
      this.logger.debug(
        `https probe ${method} ${UrlSecurityProbeService.hostOf(url)} failed: ${scrubUrlsInText((err as Error)?.message ?? '')}`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
