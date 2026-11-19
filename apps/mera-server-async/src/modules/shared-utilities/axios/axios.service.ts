import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import {
  CircuitBreakerPolicy,
  isBrokenCircuitError,
  isIsolatedCircuitError,
} from 'cockatiel';
import {
  buildProxyEgressBreaker,
  DEFAULT_PROXY_EGRESS_BREAKER,
  JobLogger,
  ProxyEgressUnavailableError,
} from '@mera/shared';
// Deep subpath import, deliberately NOT via the `@mera/shared` barrel: these
// symbols are not exported from `libs/mera-shared/src/index.ts`. The subpath is mapped in package.json and
// re-exports the same module object as the barrel, so `instanceof` still holds
// across both import styles. Matches the existing precedent at
// load-rss-feed.service.ts (`@mera/shared/url/url-security`).
import {
  isProxyInfraStatus,
  type ProxyInfraFault,
} from '@mera/shared/resilience/proxy-egress-breaker';
import {
  allowlistedAgents,
  assertPublicUrl,
  effectivePort,
  feedFetchUserAgent,
  findEgressRefusal,
  isAllowedHost,
  parseAllowHosts,
  strictAgents,
  type AllowList,
  type EgressAgents,
} from '@mera/shared/url/public-egress';

const DEFAULT_PROXY_FETCH_RETRIES = 2;

/** Largest response or request body any fetch accepts. */
const MAX_BODY_BYTES = 20 * 1024 * 1024;

/**
 * Per-attempt axios timeout. A knob rather than a literal so it can be cut
 * from Terraform during an incident, but the default is deliberately unchanged:
 * lowering it blind would start failing slow-but-healthy feeds, which is the
 * exact failure mode the feed-health work exists to eliminate. Cut it only
 * against a measured `fetchMs` p99.
 */
const DEFAULT_PROXY_FETCH_TIMEOUT_MS = 30000;

/**
 * Timeout for the LAST-RESORT direct attempt only — deliberately shorter than
 * the proxy per-attempt timeout, and not applied to `callWithoutProxy` when a
 * `gated` feed calls it as its primary path.
 *
 * It exists because the direct attempt is additive to an already-full budget:
 *   3 proxy attempts x 30s + 1 direct x 30s = 120s
 * which is EXACTLY `QUEUE_TIMEOUTS['load-rss-feed']`. At that point the
 * processor's AbortController fires at the same instant the direct attempt
 * times out, and the job dies with an AbortError -> UnrecoverableError instead
 * of a categorized FeedFetchError — losing the feed-health signal for every
 * slow-failing feed, which is the opposite of what this budget is for.
 *
 * 15s keeps the worst case at 105s with 15s left for decode/parse/insert.
 * Dropping PROXY_FETCH_RETRIES to 1 (planned, from Terraform) widens that to
 * 45s; this constant is what makes the budget safe until then.
 */
const DEFAULT_DIRECT_FALLBACK_TIMEOUT_MS = 15000;

/**
 * Number of dedicated axios instances built per geo-targeted country pool.
 * A small spread of the global proxy entries, re-tagged to the country.
 */
const PER_COUNTRY_INSTANCES = 4;

/** Bytes of a proxy error body kept for diagnosis. */
const BODY_SNIPPET_BYTES = 200;

/**
 * How long the infra latch sheds before releasing ONE probe.
 *
 * Deliberately the breaker's own half-open interval, so the two recovery
 * cadences match by construction rather than by two numbers that agree today.
 */
const INFRA_PROBE_INTERVAL_MS = DEFAULT_PROXY_EGRESS_BREAKER.halfOpenAfterMs;

/** Window over which distinct faulting proxy entries are counted. */
const INFRA_INSTANCE_WINDOW_MS =
  DEFAULT_PROXY_EGRESS_BREAKER.samplingDurationMs;

/**
 * Distinct PROXY_URLS entries that must fault before the latch engages.
 *
 * This is the whole discrimination between "the account is out of quota" and
 * "one entry in the rotation has a bad credential". Quota hits every entry;
 * a bad credential hits exactly one, forever, and would otherwise latch
 * globally on its first fault.
 *
 * Without the threshold a 3% egress failure presents as a 100% ingest outage:
 * any single 407 sheds everything for the probe interval, and at ~8 rps a
 * rotation of 32 entries produces enough faults per cycle for those shed
 * windows to cover it end to end. The symptom (all ingest stopped) points
 * nowhere near the cause (one malformed entry during a secret rotation).
 *
 * Two is enough because a real quota event fails every concurrent request, so
 * the second distinct entry arrives within a second or two at concurrency 48.
 * Note the known edge: two entries mistyped in the same rotation WILL latch,
 * even though 30 of 32 are healthy. That is accepted; failing safe on an
 * ambiguous signal is the right side to err on.
 */
const MIN_DISTINCT_INFRA_INSTANCES = 2;

// Decodo DC locations — verified 2026-07-16 via account probe
const DC_SUPPORTED_COUNTRIES = new Set([
  'au',
  'br',
  'ca',
  'cn',
  'de',
  'fr',
  'gb',
  'hk',
  'il',
  'in',
  'it',
  'jp',
  'kr',
  'nl',
  'ro',
  'sg',
  'tr',
  'us',
]);

/** Shape of an axios request rejection, as needed for retry decisions. */
type ProxyRequestError = Error & {
  code?: string;
  response?: { status?: number; data?: unknown };
  /** Attached at the throw site by `markInfraFault`. See {@link ProxyInfraFault}. */
  meraInfraFault?: ProxyInfraFault;
};

/** One country-pool slot: the instance plus which PROXY_URLS entry built it. */
interface CountryPoolEntry {
  instance: AxiosInstance;
  /**
   * Index into `proxyUrls`, NOT into the country pool. The country pool holds
   * at most PER_COUNTRY_INSTANCES entries drawn from a much larger list, so its
   * own 0..3 offset says nothing about which proxy entry is involved. Carrying
   * the source index is what lets a fault from the country path and a fault
   * from the global path be recognised as the same underlying proxy.
   */
  sourceIndex: number;
}

/** Per-call overrides for {@link AxiosService.callUsingProxy}. */
export interface ProxyCallOptions {
  /**
   * Whether a spent proxy path may fall back to one direct attempt. Optional
   * and defaults to the pre-existing behaviour (true) so no existing call site
   * changes meaning.
   */
  allowDirectFallback?: boolean;
  /**
   * Reports which egress actually served the request. Callers persist feed
   * health from this; deriving it from a flag instead is how `fetchMeta.via`
   * came to report 'proxy' for requests the direct fallback served.
   */
  onVia?: (via: 'proxy' | 'direct') => void;
}

@Injectable()
export class AxiosService {
  private readonly logger = new Logger(AxiosService.name);
  private readonly axiosProxyInstances: AxiosInstance[] = [];
  private readonly directInstance: AxiosInstance;
  /** Hosts and ports the operator allows to be private (`FEED_FETCH_ALLOW_HOSTS`). */
  private readonly allowList: AllowList;
  /** Built once. Only a listed source ever gets these; every other source gets the strict pair. */
  private readonly allowedAgents: EgressAgents;
  private readonly userAgent: string;
  private readonly proxyFetchRetries: number;
  /** Per-attempt axios timeout (ms), from `PROXY_FETCH_TIMEOUT_MS`. */
  private readonly fetchTimeoutMs: number;
  private proxyRoundRobinIndex = 0;

  /**
   * Pool-wide breaker, ONE instance for the service. It is a Nest singleton, so
   * this is shared across every concurrent worker job — that sharing is the
   * mechanism. Null when disabled by config.
   */
  private readonly egressBreaker: CircuitBreakerPolicy | null;
  private readonly directFallbackEnabled: boolean;
  /** Timeout for the last-resort direct attempt only (not the gated path). */
  private readonly directFallbackTimeoutMs: number;
  private readonly jobLogger: JobLogger;
  /** When the breaker last opened, for the `openForMs` on the close line. */
  private breakerOpenedAt: number | null = null;

  // ── Proxy-infrastructure latch ──────────────────────────────────────────
  //
  // Owns BOTH detection and shedding for a proxy quota or credential event,
  // deliberately as one mechanism. The breaker cannot do this job: once the
  // latch sheds, it sheds BEFORE `breaker.execute()`, which starves the
  // SamplingBreaker of numerator and denominator alike. Throughput through it
  // collapses to one probe per interval (~0.067 rps) against `minimumRps: 3`,
  // so it could never open however bad the fault fraction looked, and its
  // half-open probe could never govern recovery. Hence the local timer below,
  // and hence 407 is NOT in EGRESS_FAULT_STATUSES.

  /** Shed until this timestamp; null means not latched. */
  private latchedUntil: number | null = null;
  /**
   * A probe is out. Set SYNCHRONOUSLY in the same tick as the expiry check,
   * before any await, or all 48 workers see an expired latch in the same
   * window and release 48 probes at the worst possible moment.
   */
  private probeInFlight = false;
  /**
   * Whether the current infra episode has already been logged. SEPARATE state
   * from the latch on purpose: sharing them would re-emit `proxy_infra_error`
   * on every re-latch, so a three-hour storm would produce ~720 lines instead
   * of one, and the only signal that detects a quota event at all would be
   * filtered as noise by whoever had to read the logs during it.
   */
  private infraEpisodeLogged = false;
  /** Last fault time per PROXY_URLS index, for the distinct-entry threshold. */
  private readonly infraFaultsByInstance = new Map<number, number>();

  /**
   * Raw proxy URL entries kept from config so per-country pools can be derived
   * from them (username re-tagged for geo targeting). Never logged.
   */
  private readonly proxyUrls: string[] = [];
  /** Lazily-built per-country instance pools, keyed by lowercase alpha-2 cc. */
  private readonly countryPools = new Map<string, CountryPoolEntry[]>();
  /** Per-country round-robin counter so retries hit different instances. */
  private readonly countryRoundRobinIndex = new Map<string, number>();

  constructor(private configService: ConfigService) {
    this.allowList = parseAllowHosts(configService);
    this.allowedAgents = allowlistedAgents(this.allowList);
    this.userAgent = feedFetchUserAgent(configService);
    if (this.allowList.length > 0) {
      this.logger.log(
        `Feed fetches may reach private addresses at: ${this.allowList.map((e) => `${e.host} (ports ${e.ports.join(', ')})`).join('; ')}`,
      );
    }

    // Resolved BEFORE any instance is built — createAxiosInstance() reads it.
    this.fetchTimeoutMs = this.readPositiveInt(
      'PROXY_FETCH_TIMEOUT_MS',
      DEFAULT_PROXY_FETCH_TIMEOUT_MS,
    );

    this.directInstance = this.createAxiosInstance(null, -1);
    this.proxyUrls = this.getProxyUrls();
    this.initializeInstances();

    // Each attempt uses `fetchTimeoutMs` (default 30s), so attempts × timeout
    // must stay under the fetch processors' 2-min job budget. Default of 2
    // retries (3 attempts total) = 3 × 30s = 90s, which fits.
    this.proxyFetchRetries = this.readPositiveInt(
      'PROXY_FETCH_RETRIES',
      DEFAULT_PROXY_FETCH_RETRIES,
      0,
    );

    this.jobLogger = new JobLogger({
      job: 'proxy-egress',
      level: JobLogger.parseLevel(this.configService?.get<string>('LOG_LEVEL')),
    });

    this.directFallbackEnabled = this.readBool(
      'FEED_DIRECT_FALLBACK_ENABLED',
      true,
    );
    this.directFallbackTimeoutMs = this.readPositiveInt(
      'FEED_DIRECT_FALLBACK_TIMEOUT_MS',
      DEFAULT_DIRECT_FALLBACK_TIMEOUT_MS,
    );

    this.egressBreaker = this.readBool('PROXY_EGRESS_BREAKER_ENABLED', true)
      ? this.buildBreaker()
      : null;
  }

  private buildBreaker(): CircuitBreakerPolicy {
    const options = {
      faultThreshold: this.readFloat(
        'PROXY_EGRESS_BREAKER_THRESHOLD',
        DEFAULT_PROXY_EGRESS_BREAKER.faultThreshold,
      ),
      samplingDurationMs: this.readPositiveInt(
        'PROXY_EGRESS_BREAKER_DURATION_MS',
        DEFAULT_PROXY_EGRESS_BREAKER.samplingDurationMs,
      ),
      minimumRps: this.readFloat(
        'PROXY_EGRESS_BREAKER_MIN_RPS',
        DEFAULT_PROXY_EGRESS_BREAKER.minimumRps,
      ),
      halfOpenAfterMs: this.readPositiveInt(
        'PROXY_EGRESS_BREAKER_HALF_OPEN_MS',
        DEFAULT_PROXY_EGRESS_BREAKER.halfOpenAfterMs,
      ),
    };

    const breaker = buildProxyEgressBreaker(options);

    // These two lines are the only clean measurement we have of the 503 bursts
    // — how often the pool degrades and for how long. The alert keys on
    // `proxy_egress_open`.
    breaker.onBreak(() => {
      this.breakerOpenedAt = Date.now();
      this.jobLogger.warn('proxy_egress_open', {
        faultThreshold: options.faultThreshold,
        samplingDurationMs: options.samplingDurationMs,
        minimumRps: options.minimumRps,
      });
    });
    breaker.onReset(() => {
      const openForMs = this.breakerOpenedAt
        ? Date.now() - this.breakerOpenedAt
        : null;
      this.breakerOpenedAt = null;
      this.jobLogger.info('proxy_egress_closed', { openForMs });
    });

    return breaker;
  }

  /** Read a boolean knob; only the exact string `false` disables a default-on flag. */
  private readBool(key: string, fallback: boolean): boolean {
    const raw = this.configService?.get<string>(key);
    if (raw === undefined || raw === null || String(raw) === '') {
      return fallback;
    }
    return String(raw) !== 'false';
  }

  /** Read a fractional knob (thresholds, rates) — parseInt would floor 0.5 to 0. */
  private readFloat(key: string, fallback: number): number {
    const raw = this.configService?.get<number>(key, fallback) ?? fallback;
    const parsed = parseFloat(String(raw));
    return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
  }

  /**
   * Read an integer knob, falling back to the code default on anything
   * unparseable or below `min`.
   *
   * The clamp is not defensive padding: these are the knobs meant to be changed
   * from Terraform mid-incident, and `configService.get<number>` hands back the
   * raw string for a garbage value. A typo must degrade to the default, never
   * take the service down on the one lever being reached for.
   */
  private readPositiveInt(key: string, fallback: number, min = 1): number {
    const raw = this.configService?.get<number>(key, fallback) ?? fallback;
    const parsed = parseInt(String(raw), 10);
    return Number.isNaN(parsed) || parsed < min ? fallback : parsed;
  }

  /**
   * Initialize axios instances with proxy configuration
   * Creates one instance per proxy URL
   */
  private initializeInstances(): void {
    const proxyUrls = this.proxyUrls;

    if (proxyUrls.length === 0) {
      // Create a single instance without proxy
      const instance = this.createAxiosInstance(null, 0);
      this.axiosProxyInstances.push(instance);
      return;
    }

    // Create one instance per proxy URL
    proxyUrls.forEach((proxyUrl, index) => {
      const instance = this.createAxiosInstance(proxyUrl, index);
      this.axiosProxyInstances.push(instance);
    });
  }

  /**
   * Load and validate proxy URLs from environment configuration
   */
  private getProxyUrls(): string[] {
    const proxyUrlsString = this.configService.get<string>('PROXY_URLS', '');

    if (!proxyUrlsString) {
      this.logger.warn(
        'No PROXY_URLS configured - requests will be made directly',
      );
      return [];
    }

    const proxyUrls = proxyUrlsString
      .split(',')
      .map((url) => url.trim())
      .filter((url) => url.length > 0)
      .filter((url) => {
        try {
          new URL(url);
          return true;
        } catch {
          this.logger.warn(`Invalid proxy URL skipped: ${url}`);
          return false;
        }
      });

    return proxyUrls;
  }

  /**
   * Create a single axios instance with optional proxy configuration
   */
  private createAxiosInstance(
    proxyUrl: string | null,
    instanceIndex: number,
  ): AxiosInstance {
    const timeout = this.fetchTimeoutMs;

    const defaultHeaders = {
      'User-Agent': this.userAgent,
    };
    const limits = {
      timeout,
      headers: defaultHeaders,
      // feeds behind redirect chains exceed axios's default of 5
      maxRedirects: 10,
      // HTTP_PROXY and HTTPS_PROXY are ignored: PROXY_URLS is the only proxy.
      proxy: false as const,
      maxContentLength: MAX_BODY_BYTES,
      maxBodyLength: MAX_BODY_BYTES,
      // Plain http, including every http redirect hop, never leaves through the pool.
      httpAgent: strictAgents.http,
    };

    if (proxyUrl) {
      const proxyAgent = new HttpsProxyAgent(proxyUrl, {
        rejectUnauthorized: false,
      });

      proxyAgent.on('error', (error: Error) => {
        this.logger.error(
          `Proxy agent error (instance ${instanceIndex}): ${error.message}`,
        );
      });

      const axiosInstance = axios.create({
        ...limits,
        httpsAgent: proxyAgent,
      });

      axiosInstance.interceptors.response.use(
        (response) => response,
        (error: any) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          if (error.request) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            const req = error.request;
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            if (req.socket) {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
              req.socket.removeAllListeners('error');
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            if (req.connection) {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
              req.connection.removeAllListeners('error');
            }
          }
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject(error);
        },
      );

      return axiosInstance;
    }

    return axios.create({ ...limits, httpsAgent: strictAgents.https });
  }

  /** Whether the request's own address is one the operator listed. */
  private isListed(url: string | undefined): boolean {
    try {
      const parsed = new URL(url ?? '');
      return isAllowedHost(
        this.allowList,
        parsed.hostname,
        effectivePort(parsed),
      );
    } catch {
      return false;
    }
  }

  /**
   * One attempt's request config: its own deadline, a redirect check wrapped
   * around the caller's hook, and the agents that fit the source. A listed
   * source gets the allowlisted agents; every other source keeps the strict
   * ones, so its redirect into a listed private host is still refused at the
   * socket.
   */
  private guarded(
    config: AxiosRequestConfig,
    listed: boolean,
  ): AxiosRequestConfig {
    const callerHook = config.beforeRedirect;
    return {
      ...config,
      // Wall-clock limit for this attempt, body included: the axios `timeout`
      // and the redirect timer both stop once the response headers arrive, so
      // only an abort signal bounds a source that drips its body. Twice the
      // per-attempt timeout (60 s at the default 30 s). Fresh per attempt.
      signal: config.signal ?? AbortSignal.timeout(this.fetchTimeoutMs * 2),
      ...(listed
        ? {
            httpAgent: this.allowedAgents.http,
            httpsAgent: this.allowedAgents.https,
          }
        : {}),
      beforeRedirect: (options, details, request) => {
        callerHook?.(options, details, request);
        const host = String(options.hostname ?? '');
        const port = options.port ? `:${String(options.port)}` : '';
        assertPublicUrl(
          `${String(options.protocol)}//${host.includes(':') ? `[${host}]` : host}${port}/`,
          listed ? this.allowList : [],
        );
      },
    };
  }

  /**
   * Make a request using a round-robin selected axios instance, retrying
   * against the next proxy instance when the failure looks like something a
   * different egress IP could plausibly fix (network error/timeout, or an
   * HTTP 5xx/429/403 response). Other 4xx errors are not retried.
   * @param config - Axios request configuration
   * @returns Promise with the axios response
   */
  async callUsingProxy<T = any>(
    config: AxiosRequestConfig,
    countryCode?: string,
    opts: ProxyCallOptions = {},
  ): Promise<AxiosResponse<T>> {
    assertPublicUrl(config.url ?? '', this.allowList);
    if (this.isListed(config.url)) {
      // A listed source is on the operator's own network, which no proxy pool
      // can reach.
      const response = await this.callWithoutProxy<T>(config);
      opts.onVia?.('direct');
      return response;
    }

    const gate = this.claimEgress();
    if (gate === 'shed') {
      // The pool is known bad. Writing nothing at all is the point: the caller
      // turns this into a silent shed rather than a feed-attributable failure.
      throw new ProxyEgressUnavailableError();
    }

    try {
      return await this.attemptEgress<T>(config, countryCode, opts);
    } finally {
      // In a `finally` so a thrown probe cannot wedge the slot shut forever,
      // which would reintroduce the never-recovers bug one layer up.
      if (gate === 'probe') {
        this.probeInFlight = false;
      }
    }
  }

  /**
   * Decide whether this caller may touch the proxy pool, SYNCHRONOUSLY.
   *
   * Every branch completes in one tick with no await, which is the whole point.
   * `AxiosService` is a Nest singleton shared by 48 concurrent workers, so a
   * check-then-act split across an await would let every worker that reached
   * the expiry check in that window release its own probe: 48 probes at the
   * exact moment the pool is known to be unwell.
   */
  private claimEgress(): 'open' | 'probe' | 'shed' {
    if (this.latchedUntil === null) {
      return 'open';
    }
    if (this.probeInFlight) {
      return 'shed';
    }
    const now = Date.now();
    if (now < this.latchedUntil) {
      return 'shed';
    }
    // Claim the slot AND re-arm the timer before returning, so the window in
    // which a second caller could also claim is zero-width rather than merely
    // narrow.
    this.probeInFlight = true;
    this.latchedUntil = now + INFRA_PROBE_INTERVAL_MS;
    return 'probe';
  }

  /** The proxy path proper, plus latch bookkeeping on the outcome. */
  private async attemptEgress<T>(
    config: AxiosRequestConfig,
    countryCode: string | undefined,
    opts: ProxyCallOptions,
  ): Promise<AxiosResponse<T>> {
    let proxyError: unknown;
    let circuitOpen: boolean;

    try {
      const response = await this.executeProxyPath<T>(config, countryCode);
      this.noteEgressReachable();
      opts.onVia?.('proxy');
      return response;
    } catch (error) {
      proxyError = error;
      circuitOpen =
        isBrokenCircuitError(error) || isIsolatedCircuitError(error);

      const fault = (error as ProxyRequestError)?.meraInfraFault;
      if (fault) {
        // Latch only once enough DISTINCT proxy entries have faulted. Below
        // that this is one bad entry, and the feed takes the ordinary
        // `blocked` path it takes today rather than the whole catalogue
        // stopping.
        if (this.recordInfraFault(fault)) {
          throw new ProxyEgressUnavailableError();
        }
      } else if (!circuitOpen && (error as ProxyRequestError)?.response) {
        // CLEAN PROBE = REACHABILITY, NOT SUCCESS. Any origin response at all,
        // including 404/403/5xx, proves the request traversed the proxy.
        //
        // A 2xx-only test would be a silent trap: probes are drawn from the
        // normal fetch queue, a meaningful slice of the catalogue 404s or 403s
        // at any moment, and each such probe would re-arm the latch for another
        // interval on evidence about the ORIGIN rather than about the pool. A
        // healthy pool with ingest shed indefinitely and nothing in the logs
        // explaining why is the worst outcome available here, and it would be
        // reached by a change that looks like tightening.
        //
        // That probes come from the normal queue is also what bounds the
        // damage: each one is a different feed, so a chronically dead origin
        // costs at most one interval and can never hold the latch. Introducing
        // a DEDICATED probe target would silently break that property.
        this.noteEgressReachable();
      }
      // No response at all stays ambiguous (could be us, could be the origin)
      // and deliberately does NOT clear the latch, matching isEgressFault.
    }

    // The proxy path is spent. Direct is worth ONE attempt when a different
    // egress could plausibly change the answer — which is exactly the existing
    // retryable predicate (no response, 5xx, 429, 403), plus the circuit being
    // open. A 404/410/401 is a property of the URL, so direct would only waste
    // a request and is rethrown untouched.
    //
    // That direct works at all is not an assumption: `gated` feeds — government
    // WAFs that 403 datacenter proxy ranges but answer Cloud Run's egress — are
    // fetched this way today, 476 of 504 of them successfully.
    //
    // LATENT COUPLING, read this before touching PROXY_INFRA_STATUSES or
    // EGRESS_FAULT_STATUSES. `allowDirectFallback` bounds ONE specific gap and
    // nothing wider.
    //
    // Adding 407 (or any other proxy-infrastructure status) to
    // EGRESS_FAULT_STATUSES in proxy-egress-breaker.ts would make the breaker
    // open during a proxy quota or credential event. That sets `circuitOpen`
    // below, which arms this direct fallback for EVERY feed in the catalogue at
    // once, at concurrency 48 with no BullMQ limiter, no per-host cap and no
    // per-proxy cap. That is the pattern that burns an egress IP, and it is
    // exactly what `allowDirectFallback: false` refuses. The two must never be
    // separated: whoever adds the status must keep the gate.
    //
    // Be precise about the scope. The `circuitOpen` half ALREADY arms
    // catalogue-wide direct today whenever the breaker opens on 5xx or
    // response-less errors. That is intentional and this
    // code does not change it. Nothing here makes the direct fallback bounded in
    // general; it is not.
    const allowDirectFallback = opts.allowDirectFallback !== false;
    const worthTryingDirect =
      circuitOpen ||
      this.isRetryableProxyError(proxyError as ProxyRequestError);

    if (
      this.directFallbackEnabled &&
      allowDirectFallback &&
      worthTryingDirect
    ) {
      try {
        // Per-request `timeout` overrides the instance default, so the gated
        // path keeps the full budget while this additive attempt does not.
        const response = await this.callWithoutProxy<T>({
          ...config,
          timeout: this.directFallbackTimeoutMs,
        });
        this.jobLogger.info('direct_fetch_used', {
          outcome: 'success',
          status: response.status,
          reason: circuitOpen ? 'egress_open' : 'proxy_exhausted',
        });
        opts.onVia?.('direct');
        return response;
      } catch (directError) {
        // A refusal is about the address, not the proxy, so it is the answer.
        if (findEgressRefusal(directError)) {
          throw directError;
        }
        this.jobLogger.info('direct_fetch_used', {
          outcome: 'failure',
          status: (directError as ProxyRequestError)?.response?.status ?? null,
          reason: circuitOpen ? 'egress_open' : 'proxy_exhausted',
        });
        // Fall through and report the PROXY failure, not the direct one: the
        // proxy error carries the categorisation feed health is built on.
      }
    }

    // With the circuit open the caller must NOT see a normal fetch failure —
    // that would be classified as `transient` and would quarantine the whole
    // catalogue on our own outage. It gets a distinct type instead, which the
    // load-rss-feed seam turns into a silent shed.
    if (circuitOpen) {
      throw new ProxyEgressUnavailableError();
    }
    throw proxyError;
  }

  /**
   * Run the proxy path under the pool-wide breaker.
   *
   * The breaker wraps the WHOLE retry budget, deliberately from outside it.
   * Inside the loop, `isRetryableProxyError` returns true for any error with no
   * `.response` — and `BrokenCircuitError` has none — so every open-circuit
   * rejection would read as retryable, burning the budget on the breaker's own
   * refusals and logging misleading "Retrying fetch via next proxy" warns. From
   * outside, what the breaker measures is the final outcome of a whole feed
   * fetch, which is the interpretable number.
   */
  private async executeProxyPath<T>(
    config: AxiosRequestConfig,
    countryCode?: string,
  ): Promise<AxiosResponse<T>> {
    // A refusal passes through the breaker uncounted: isEgressFault rejects it.
    const dispatch = () => this.dispatchViaPool<T>(config, countryCode);
    return this.egressBreaker
      ? this.egressBreaker.execute(dispatch)
      : dispatch();
  }

  /** Pool selection: geo-targeted when supported, global otherwise. */
  private async dispatchViaPool<T>(
    config: AxiosRequestConfig,
    countryCode?: string,
  ): Promise<AxiosResponse<T>> {
    const cc = this.normalizeCountryCode(countryCode);

    // Valid country that Decodo's DC pool can actually serve + a configured
    // proxy pool → geo-targeted fetch. Otherwise (no cc, junk cc, unsupported
    // country, or no proxies configured) keep the global-pool behavior; an
    // unsupported cc never builds a country pool.
    if (cc && DC_SUPPORTED_COUNTRIES.has(cc) && this.proxyUrls.length > 0) {
      return this.callUsingCountryPool<T>(config, cc);
    }

    return this.callUsingGlobalPool<T>(config);
  }

  /**
   * Global round-robin proxy pool with retry — the original, country-agnostic
   * fetch path. Retries advance the round-robin so a different egress IP is
   * tried on retryable failures (network error/timeout, HTTP 5xx/429/403).
   */
  private async callUsingGlobalPool<T = any>(
    config: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    const maxAttempts = 1 + this.proxyFetchRetries;
    let lastError: ProxyRequestError = new Error(
      'AxiosService: no attempts were made',
    );
    let lastResponse: AxiosResponse<T> | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const index =
        this.proxyRoundRobinIndex++ % this.axiosProxyInstances.length;
      const instance = this.axiosProxyInstances[index];
      const isLastAttempt = attempt === maxAttempts;

      try {
        const response = await instance.request<T>(this.guarded(config, false));

        // A caller may pass a permissive `validateStatus`, in which case a
        // retryable status resolves instead of rejecting. Spend the retry
        // budget on it anyway — otherwise the retry is silently disabled.
        if (!isLastAttempt && this.isRetryableStatus(response.status)) {
          lastResponse = response;
          this.logger.warn(
            `Retrying fetch via next proxy (attempt ${attempt + 1}/${maxAttempts}, instance ${this.proxyRoundRobinIndex % this.axiosProxyInstances.length}): resolved HTTP ${response.status}`,
          );
          continue;
        }

        return response;
      } catch (error) {
        lastError = this.markInfraFault(error as ProxyRequestError, index);

        if (!this.isRetryableProxyError(lastError) || isLastAttempt) {
          throw lastError;
        }

        const nextIndex =
          this.proxyRoundRobinIndex % this.axiosProxyInstances.length;
        this.logger.warn(
          `Retrying fetch via next proxy (attempt ${attempt + 1}/${maxAttempts}, instance ${nextIndex}): ${lastError.message}`,
        );
      }
    }

    // Defensive: the loop above always returns or throws on the last attempt.
    if (lastResponse) {
      return lastResponse;
    }
    throw lastError;
  }

  /**
   * Geo-targeted proxy fetch. Attempts start on the country's own pool; on the
   * FIRST failed country-pool attempt (ANY error, including non-retryable ones
   * like Decodo's instant HTTP 400 for unservable geos) the request switches
   * permanently to the global pool for all remaining attempts, so a geo
   * failure degrades to the pre-geo behavior instead of failing the feed.
   * Global-pool attempts keep the standard rules: non-retryable errors rethrow
   * immediately; retryable ones consume the remaining attempt budget. The last
   * error is rethrown unchanged.
   */
  private async callUsingCountryPool<T = any>(
    config: AxiosRequestConfig,
    cc: string,
  ): Promise<AxiosResponse<T>> {
    const pool = this.getOrCreateCountryPool(cc);
    const maxAttempts = 1 + this.proxyFetchRetries;
    let lastError: ProxyRequestError = new Error(
      'AxiosService: no attempts were made',
    );
    let lastResponse: AxiosResponse<T> | undefined;
    let onGlobalPool = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const isLastAttempt = attempt === maxAttempts;

      let instance: AxiosInstance;
      let poolLabel: string;
      /** Pool-local offset, for the log line only. */
      let instanceIndex: number;
      /** Index into `proxyUrls`, for fault identity across both pools. */
      let sourceIndex: number;
      if (onGlobalPool) {
        instanceIndex =
          this.proxyRoundRobinIndex++ % this.axiosProxyInstances.length;
        instance = this.axiosProxyInstances[instanceIndex];
        sourceIndex = instanceIndex;
        poolLabel = 'global-fallback';
      } else {
        instanceIndex = this.nextCountryIndex(cc, pool.length);
        const entry = pool[instanceIndex];
        instance = entry.instance;
        sourceIndex = entry.sourceIndex;
        poolLabel = cc;
      }

      try {
        const response = await instance.request<T>(this.guarded(config, false));

        // Permissive `validateStatus` at the call site would otherwise resolve
        // a retryable status and silently skip the remaining attempts.
        if (!isLastAttempt && this.isRetryableStatus(response.status)) {
          lastResponse = response;
          // Same as a failure: degrade off the country pool for the remainder.
          onGlobalPool = true;
          this.logger.warn(
            `Retrying fetch via proxy (country ${cc}, pool ${poolLabel}, attempt ${attempt + 1}/${maxAttempts}, instance ${instanceIndex}): resolved HTTP ${response.status}`,
          );
          continue;
        }

        return response;
      } catch (error) {
        lastError = this.markInfraFault(
          error as ProxyRequestError,
          sourceIndex,
        );

        if (isLastAttempt) {
          throw lastError;
        }

        // A proxy-infrastructure status is scoped to the ACCOUNT, not to this
        // country pool and not to the origin, so degrading to the global pool
        // would spend a second attempt being told the same thing by the same
        // account. This is the one failure that must not take the
        // degrade-on-first-failure path below. Worth one wasted request per
        // geo-targeted feed per quota cycle; it is not a mechanism change.
        if (lastError.meraInfraFault) {
          throw lastError;
        }

        // Another pool would be refused for the same address.
        if (findEgressRefusal(lastError)) {
          throw lastError;
        }

        if (onGlobalPool) {
          // Standard global-pool rules: only retryable errors keep going.
          if (!this.isRetryableProxyError(lastError)) {
            throw lastError;
          }
        } else {
          // First country-pool failure of any kind → degrade permanently to
          // the global pool for the remaining attempts.
          onGlobalPool = true;
        }

        this.logger.warn(
          `Retrying fetch via proxy (country ${cc}, pool ${poolLabel}, attempt ${attempt + 1}/${maxAttempts}, instance ${instanceIndex}): ${lastError.message}`,
        );
      }
    }

    // Defensive: the loop above always returns or throws on the last attempt.
    if (lastResponse) {
      return lastResponse;
    }
    throw lastError;
  }

  /**
   * Validate/normalize a country code to a lowercase alpha-2 string, or
   * undefined when absent or not a two-letter code (→ global-pool behavior).
   */
  private normalizeCountryCode(countryCode?: string): string | undefined {
    if (!countryCode || !/^[a-z]{2}$/i.test(countryCode)) {
      return undefined;
    }
    return countryCode.toLowerCase();
  }

  /** Advance and return the next round-robin index within a country pool. */
  private nextCountryIndex(cc: string, poolLength: number): number {
    const current = this.countryRoundRobinIndex.get(cc) ?? 0;
    this.countryRoundRobinIndex.set(cc, current + 1);
    return current % poolLength;
  }

  /**
   * Lazily build (and cache) the axios instance pool for a country: pick a
   * deterministic spread of the configured proxy entries and re-tag each
   * username for Decodo geo targeting.
   */
  private getOrCreateCountryPool(cc: string): CountryPoolEntry[] {
    const cached = this.countryPools.get(cc);
    if (cached) {
      return cached;
    }

    const urls = this.proxyUrls;
    const count = Math.min(PER_COUNTRY_INSTANCES, urls.length);
    const step = urls.length / count;
    const pool: CountryPoolEntry[] = [];

    for (let i = 0; i < count; i++) {
      const index = Math.floor(i * step) % urls.length;
      // Raw geo-tagged proxy URL is used transiently to build the agent and is
      // never stored or logged.
      const countryUrl = this.applyCountryToProxyUrl(urls[index], cc);
      pool.push({
        instance: this.createAxiosInstance(countryUrl, index),
        sourceIndex: index,
      });
    }

    this.countryPools.set(cc, pool);
    return pool;
  }

  /**
   * Rewrite ONLY the username of a proxy URL to Decodo's geo-targeted form
   * (`user-<rawUser>-country-<cc>`); password/host/port are left unchanged.
   */
  private applyCountryToProxyUrl(rawUrl: string, cc: string): string {
    const parsed = new URL(rawUrl);
    const rawUser = decodeURIComponent(parsed.username);
    parsed.username = `user-${rawUser}-country-${cc}`;
    return parsed.toString();
  }

  /**
   * Whether an HTTP status is worth re-trying from a different egress IP:
   * 5xx (origin/edge trouble, including Cloudflare 52x), 429 (rate limited
   * per-IP) and 403 (bot protection keyed on the IP). Other 4xx (404, 410,
   * 401 …) are properties of the URL, not the IP, so they are not retried.
   */
  private isRetryableStatus(status: number): boolean {
    return status >= 500 || status === 429 || status === 403;
  }

  /**
   * Determine whether a failed request is worth retrying via a different
   * proxy instance: a network-level failure (no HTTP response at all), or an
   * HTTP 5xx/429/403 response. Other HTTP errors (404, 410, etc.) are not
   * retried since a different egress IP wouldn't change the outcome.
   */
  private isRetryableProxyError(error: ProxyRequestError): boolean {
    // Another egress or a retry would be refused for the same address.
    if (findEgressRefusal(error)) {
      return false;
    }

    const status = error.response?.status;

    if (status === undefined) {
      return true;
    }

    return this.isRetryableStatus(status);
  }

  /**
   * Record one proxy-infrastructure fault. Returns whether the pool is now
   * latched (and therefore whether this call should shed).
   */
  private recordInfraFault(fault: ProxyInfraFault): boolean {
    const now = Date.now();
    this.infraFaultsByInstance.set(fault.instanceIndex, now);

    // Drop entries older than the window so a slow trickle from one bad entry
    // can never accumulate into a false quorum. Bounded by the pool size, so
    // there is nothing here to leak.
    for (const [index, at] of this.infraFaultsByInstance) {
      if (now - at > INFRA_INSTANCE_WINDOW_MS) {
        this.infraFaultsByInstance.delete(index);
      }
    }

    if (this.infraFaultsByInstance.size < MIN_DISTINCT_INFRA_INSTANCES) {
      return false;
    }

    this.latchedUntil = now + INFRA_PROBE_INTERVAL_MS;

    // ONE line per episode, not one per re-latch. `direct_fetch_used` goes
    // QUIET during a 407 storm (407 is not retryable, so the fallback is never
    // attempted) and the breaker never opens on it, so this line is the ONLY
    // signal that will ever detect a quota event. Emitting it per probe would
    // produce ~720 lines across a three-hour storm and get it filtered, which
    // would leave the failure mode undetectable again. Do not simplify this
    // into an `onBreak` hook: that would have caught nothing during the real
    // event this was built from.
    if (!this.infraEpisodeLogged) {
      this.infraEpisodeLogged = true;
      this.jobLogger.warn('proxy_infra_error', {
        status: fault.status,
        code: fault.code,
        bodySnippet: fault.bodySnippet,
      });
    }

    return true;
  }

  /**
   * The pool answered. Clears the latch and the episode flag together, so the
   * next real episode logs again.
   */
  private noteEgressReachable(): void {
    this.infraFaultsByInstance.clear();
    if (this.latchedUntil === null) {
      return;
    }
    this.latchedUntil = null;
    this.infraEpisodeLogged = false;
  }

  /**
   * Stamp proxy-infrastructure detail onto a rejection AT THE THROW SITE.
   *
   * On the error rather than on `this` because the service is a Nest singleton
   * shared by 48 concurrent workers: a field written in a catch and read after
   * an await can be overwritten by another worker in between, which would make
   * the logged `bodySnippet` belong to a different feed than the one being
   * reported. Non-infra rejections pass through untouched.
   */
  private markInfraFault(
    error: ProxyRequestError,
    instanceIndex: number,
  ): ProxyRequestError {
    const status = error.response?.status;
    if (!isProxyInfraStatus(status)) {
      return error;
    }
    error.meraInfraFault = {
      status: status as number,
      code: error.code ?? null,
      bodySnippet: this.bodySnippet(error.response?.data),
      instanceIndex,
    };
    return error;
  }

  /**
   * First ~200 bytes of a response body, for telling one 407 from another
   * (vendor quota message vs a genuinely bad credential). The RSS call site
   * uses `responseType: 'arraybuffer'`, so this is normally a Buffer rather
   * than a string. Never includes request config or headers, which is where
   * proxy credentials live.
   */
  private bodySnippet(data: unknown): string | null {
    if (data === undefined || data === null) {
      return null;
    }
    try {
      if (Buffer.isBuffer(data)) {
        return data.subarray(0, BODY_SNIPPET_BYTES).toString('utf8');
      }
      if (data instanceof ArrayBuffer) {
        return Buffer.from(data)
          .subarray(0, BODY_SNIPPET_BYTES)
          .toString('utf8');
      }
      const asText =
        typeof data === 'string' ? data : JSON.stringify(data) || '';
      return asText.slice(0, BODY_SNIPPET_BYTES);
    } catch {
      return null;
    }
  }

  /**
   * Make a request without using a proxy
   * @param config - Axios request configuration
   * @returns Promise with the axios response
   */
  async callWithoutProxy<T = any>(
    config: AxiosRequestConfig,
  ): Promise<AxiosResponse<T>> {
    assertPublicUrl(config.url ?? '', this.allowList);
    return this.directInstance.request<T>(
      this.guarded(config, this.isListed(config.url)),
    );
  }
}
