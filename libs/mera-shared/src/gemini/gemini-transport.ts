import { ConfigService } from '@nestjs/config';
import { JobLogger } from '../job-logger/job-logger';

/** Mints an OAuth2 access token for the Vertex transport. Returns null when a
 * token cannot be obtained, which the caller surfaces as a terminal error. */
export type GeminiTokenFn = () => Promise<string | null>;

/**
 * The one place that decides HOW a Gemini call is addressed and authenticated.
 *
 * Four services call `:generateContent` (translation, enrichment, fact-check,
 * relevance-confirm) and each used to carry its own byte-identical copy of the
 * URL template, the API-key query param and the `content-type` header. That
 * duplication is the friction this removes: the 2026-08-19 spend-cap outage
 * needed the transport swapped, and four copies meant four chances to miss one.
 *
 * `GEMINI_TRANSPORT` is the single switch for all of them:
 *   developer -> generativelanguage.googleapis.com + `?key=<GEMINI_API_KEY>`
 *   vertex    -> {loc}-aiplatform.googleapis.com   + `Authorization: Bearer`
 *             -> aiplatform.googleapis.com         when the location is `global`
 *
 * Flipping it back to `developer` returns every call site to AI Studio.
 */
export class GeminiTransport {
  private readonly transport: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly vertexProject: string;
  private readonly vertexLocation: string;
  private readonly tokenFn: GeminiTokenFn;
  private googleAuth: {
    getAccessToken(): Promise<string | null | undefined>;
  } | null = null;

  constructor(
    config: ConfigService,
    private readonly logger: JobLogger,
    tokenFn?: GeminiTokenFn,
  ) {
    this.transport = config.get<string>('GEMINI_TRANSPORT', 'developer');
    this.apiKey = config.get<string>('GEMINI_API_KEY', '');
    this.baseUrl = config.get<string>(
      'GEMINI_BASE_URL',
      'https://generativelanguage.googleapis.com/v1beta',
    );
    this.vertexProject = config.get<string>('GEMINI_VERTEX_PROJECT', '');
    this.vertexLocation = config.get<string>(
      'GEMINI_VERTEX_LOCATION',
      'europe-west1',
    );
    // Deliberately NOT routed through any injected `fetchFn`: google-auth-library
    // owns its own transport and caches the token, so each service's fetch double
    // stays a faithful count of Gemini calls.
    this.tokenFn = tokenFn ?? (() => this.defaultAccessToken());
  }

  get isVertex(): boolean {
    return this.transport === 'vertex';
  }

  /** Vertex authenticates with the runtime SA, so no API key is required. */
  get isConfigured(): boolean {
    return this.isVertex || this.apiKey.length > 0;
  }

  /** Preserves the original per-service error text so callers and their specs
   * keep the same contract on the developer path. */
  assertConfigured(): void {
    if (!this.isConfigured) {
      throw new Error('GEMINI_API_KEY is not configured');
    }
  }

  /** Vertex host for the configured location.
   *
   * `global` is NOT a region and takes the UNPREFIXED host: the naive
   * `global-aiplatform.googleapis.com` resolves but 404s every request.
   * The path segment stays `/locations/global/`. Verified 2026-08-20.
   *
   * This matters because model availability is per-location: `europe-west1`
   * serves ONLY the 2.5 family, while every 3.x model (3.5-flash-lite,
   * 3.6-flash, 3.7-flash) is global-only. */
  private get vertexHost(): string {
    return this.vertexLocation === 'global'
      ? 'https://aiplatform.googleapis.com'
      : `https://${this.vertexLocation}-aiplatform.googleapis.com`;
  }

  generateContentUrl(model: string): string {
    if (this.isVertex) {
      return (
        `${this.vertexHost}/v1/projects/` +
        `${this.vertexProject}/locations/${this.vertexLocation}/publishers/` +
        `google/models/${model}:generateContent`
      );
    }
    return `${this.baseUrl}/models/${model}:generateContent?key=${this.apiKey}`;
  }

  /** Boot-time model-metadata probe. Vertex has no equivalent `GET /models/{m}`
   * on the publisher path, so callers must treat null as "skip the check"
   * rather than firing a request that would fail silently. */
  modelMetadataUrl(model: string): string | null {
    if (this.isVertex) return null;
    return `${this.baseUrl}/models/${model}?key=${this.apiKey}`;
  }

  /** `flex` bills the call at Vertex Flex PayGo (half price, slower, may be
   * throttled). Flex exists only on Vertex at `global`, so elsewhere it is
   * ignored. `timeoutMs` becomes `X-Server-Timeout`, how long Vertex may hold
   * a flex request. */
  async headers(
    opts: { flex?: boolean; timeoutMs?: number } = {},
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.isVertex) {
      const token = await this.tokenFn();
      if (!token) throw new Error('vertex access token unavailable');
      headers.Authorization = `Bearer ${token}`;
      if (opts.flex && this.vertexLocation === 'global') {
        headers['X-Vertex-AI-LLM-Request-Type'] = 'shared';
        headers['X-Vertex-AI-LLM-Shared-Request-Type'] = 'flex';
        if (opts.timeoutMs) {
          headers['X-Server-Timeout'] = String(
            Math.ceil(opts.timeoutMs / 1000),
          );
        }
      }
    }
    return headers;
  }

  /** Lazily-built ADC token source. Mirrors the in-repo precedent in
   * `google-play-integrity.adapter.ts`: lazy `??=`, scoped GoogleAuth, and
   * warn-and-return-null rather than throwing out of the auth layer. */
  private async defaultAccessToken(): Promise<string | null> {
    try {
      if (!this.googleAuth) {
        const { GoogleAuth } = await import('google-auth-library');
        this.googleAuth = new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        });
      }
      return (await this.googleAuth.getAccessToken()) ?? null;
    } catch (err) {
      this.logger.warn('gemini_vertex_token_error', {
        reason: (err as Error).message,
      });
      return null;
    }
  }
}
