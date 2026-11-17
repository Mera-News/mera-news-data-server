import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobLogger } from '../job-logger/job-logger';
import {
  GeminiTransport,
  type GeminiTokenFn,
} from '../gemini/gemini-transport';
import { CountryCodeMapper } from '../profile-serializer/country-code-mapper';
import {
  ArticleEnrichment,
  GeoTag,
  EnrichmentInput,
  EnrichmentOutput,
  ArticleEnrichmentProvider,
} from './article-enrichment-provider.port';
import {
  SUPRANATIONAL_CODES,
  isSupranationalCode,
} from './supranational-codes';
import { CONTENT_CATEGORIES, isValidContentCategory } from './content-taxonomy';

type FetchFn = typeof fetch;
type SleepFn = (ms: number) => Promise<void>;

const SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
];

/** The fixed event-type vocabulary. Anything else coerces to 'other'. */
export const EVENT_TYPES = [
  'election',
  'policy',
  'conflict',
  'crime',
  'protest',
  'disaster',
  'accident',
  'weather',
  'business',
  'sports',
  'entertainment',
  'health',
  'science_tech',
  'obituary',
  'other',
] as const;

const EVENT_TYPE_SET = new Set<string>(EVENT_TYPES);

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  /**
   * Gemini's own token accounting for the call. Read so that the cost of a run
   * is MEASURED rather than modelled — without it, "what did this actually
   * cost?" can only be answered by the billing console, which lags by hours and
   * cannot be attributed to one backfill pass.
   */
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

interface OnceResult {
  byId: Map<string, ArticleEnrichment>;
  safetyBlocked: boolean;
}

/**
 * Gemini Flash-Lite adapter for {@link ArticleEnrichmentProvider} (served-only
 * article tagging). Mirrors {@link GeminiTranslationService} exactly for a
 * TAGGING-only call: one batched request, `responseSchema`
 * `[{id, locations, entities, event_type}]` (plus `category` only while
 * `ENRICHMENT_CATEGORY_ENABLED` is on), temperature 0, thinking disabled,
 * permissive safety thresholds + block-rate counting, every-input-id-exactly-once
 * validation, single-item retry for the misaligned/blocked subset, and a sticky
 * model-chain failover on 404/NOT_FOUND.
 *
 * Plain HTTPS via `fetch` (no SDK in business logic). `fetch`/`sleep` injected
 * for deterministic tests. The model name is `GEMINI_ENRICHMENT_MODEL`
 * (default `gemini-3.1-flash-lite`).
 *
 * Unlike the translation port, a per-item content failure does NOT carry the
 * original text through — it returns a DEGRADED {@link ArticleEnrichment} (empty
 * arrays + `event_type: 'other'`) so the article is still marked tagged.
 */
@Injectable()
export class GeminiEnrichmentService implements ArticleEnrichmentProvider {
  private readonly models: string[];
  private modelIndex = 0;
  private readonly gemini: GeminiTransport;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly fetchFn: FetchFn;
  private readonly sleep: SleepFn;
  /**
   * `ENRICHMENT_CATEGORY_ENABLED` — DEFAULT OFF. Gates the whole
   * `content_category` field: the schema property, the prompt block and the
   * parse. With it off, the request body and the prompt are byte-identical to
   * what they were before the field existed, which matters because this is ONE
   * batched call and every prompt addition perturbs fields it never mentions
   * (measured: a category block moved 63 rows' event_type and dropped entity
   * overlap to 69%). It also costs ~3.0k extra input tokens per request
   * (~+15% on the bill) to ship the 283-path enum.
   */
  private readonly categoryEnabled: boolean;

  private safetyBlocks = 0;
  private requests = 0;
  private promptTokens = 0;
  private candidateTokens = 0;

  constructor(
    config: ConfigService,
    private readonly logger: JobLogger,
    fetchFn?: FetchFn,
    sleep?: SleepFn,
    tokenFn?: GeminiTokenFn,
  ) {
    const primary = config.get<string>(
      'GEMINI_ENRICHMENT_MODEL',
      'gemini-3.1-flash-lite',
    );
    const fallbacks = config
      .get<string>('GEMINI_FALLBACK_MODELS', 'gemini-3.5-flash-lite')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0 && m !== primary);
    this.models = [primary, ...fallbacks];
    this.gemini = new GeminiTransport(config, logger, tokenFn);
    this.maxRetries = config.get<number>('GEMINI_MAX_RETRIES', 3);
    this.backoffMs = config.get<number>('GEMINI_RETRY_BACKOFF_MS', 500);
    this.categoryEnabled =
      String(
        config.get<string | boolean>('ENRICHMENT_CATEGORY_ENABLED', false),
      ).toLowerCase() === 'true';
    this.fetchFn = fetchFn ?? fetch;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get model(): string {
    return this.models[this.modelIndex];
  }

  async enrichBatch(
    items: EnrichmentInput[],
    signal?: AbortSignal,
  ): Promise<EnrichmentOutput[]> {
    if (items.length === 0) return [];
    this.gemini.assertConfigured();

    const primary = await this.requestWithRetry(items, signal);

    const outputs = new Array<EnrichmentOutput>(items.length);
    const failed: number[] = [];
    for (let idx = 0; idx < items.length; idx++) {
      const hit = primary.byId.get(items[idx].id);
      if (hit) {
        outputs[idx] = { id: items[idx].id, ...hit };
      } else {
        failed.push(idx);
      }
    }

    // Misaligned/blocked subset retries as SINGLE-item requests; still-missing
    // items degrade rather than throw (content-level failure).
    for (const idx of failed) {
      outputs[idx] = await this.tagSingle(items[idx], signal);
    }
    return outputs;
  }

  /** Single-item terminal path: on any failure, DEGRADE (empty tags + 'other'). */
  private async tagSingle(
    item: EnrichmentInput,
    signal?: AbortSignal,
  ): Promise<EnrichmentOutput> {
    try {
      const res = await this.requestWithRetry([item], signal);
      const hit = res.byId.get(item.id);
      if (hit) return { id: item.id, ...hit };
      if (res.safetyBlocked) {
        this.safetyBlocks++;
        this.logger.warn('tagging_safety_block', { id: item.id });
      } else {
        this.logger.warn('tagging_id_misalignment', { id: item.id });
      }
      return this.degrade(item.id);
    } catch (err) {
      // Terminal after retries — degrade rather than lose the article (one stuck
      // article must not fail the whole chunk).
      this.logger.warn('tagging_terminal_error', {
        id: item.id,
        reason: (err as Error).message,
      });
      return this.degrade(item.id);
    }
  }

  private degrade(id: string): EnrichmentOutput {
    return { id, geo_tags: [], entities: [], event_type: 'other' };
  }

  /** One Gemini call with backoff retry on transient errors and model-chain
   * failover on model-level terminal errors (404/NOT_FOUND). */
  private async requestWithRetry(
    items: EnrichmentInput[],
    signal?: AbortSignal,
  ): Promise<OnceResult> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.requestOnce(items, signal);
      } catch (err) {
        if (err instanceof ModelUnavailableError) {
          if (this.modelIndex < this.models.length - 1) {
            const fromModel = this.models[this.modelIndex];
            this.modelIndex++;
            const toModel = this.models[this.modelIndex];
            this.logger.warn('tagging_model_fallback', { fromModel, toModel });
            continue; // immediate retry on the fallback model, no backoff
          }
          throw err; // chain exhausted
        }
        const transient = err instanceof TransientGeminiError;
        if (transient && attempt < this.maxRetries) {
          attempt++;
          await this.sleep(this.backoffMs * Math.pow(2, attempt - 1));
          continue;
        }
        throw err instanceof TransientGeminiError ? (err.cause ?? err) : err;
      }
    }
  }

  private async requestOnce(
    items: EnrichmentInput[],
    signal?: AbortSignal,
  ): Promise<OnceResult> {
    this.requests++;
    const url = this.gemini.generateContentUrl(this.model);
    const headers = await this.gemini.headers();
    // The category property and its `required` entry are appended ONLY when the
    // flag is on, so with it off the serialized body is byte-identical to the
    // pre-category one (key insertion order included — `category` is added last).
    const properties: Record<string, unknown> = {
      id: { type: 'STRING' },
      locations: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            city: { type: 'STRING' },
            region: { type: 'STRING' },
            country_code: { type: 'STRING' },
          },
          required: ['country_code'],
        },
      },
      entities: { type: 'ARRAY', items: { type: 'STRING' } },
      event_type: { type: 'STRING', enum: [...EVENT_TYPES] },
    };
    const required = ['id', 'locations', 'entities', 'event_type'];
    if (this.categoryEnabled) {
      // The enum is load-bearing, not decoration: unconstrained, the model
      // invented 77% of the paths it returned (measured 2026-08-09).
      properties.category = { type: 'STRING', enum: [...CONTENT_CATEGORIES] };
      required.push('category');
    }

    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: this.buildPrompt(items, this.categoryEnabled) }],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties,
            required,
          },
        },
        thinkingConfig: { thinkingBudget: 0 },
      },
      safetySettings: SAFETY_CATEGORIES.map((category) => ({
        category,
        threshold: 'BLOCK_NONE',
      })),
    };

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new TransientGeminiError('gemini network error', err);
    }

    if (res.status === 429 || res.status >= 500) {
      const txt = await res.text().catch(() => '');
      throw new TransientGeminiError(
        `gemini ${res.status}: ${txt.slice(0, 200)}`,
      );
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      if (GeminiEnrichmentService.isModelUnavailable(res.status, txt)) {
        throw new ModelUnavailableError(
          this.model,
          `gemini ${res.status}: ${txt.slice(0, 200)}`,
        );
      }
      throw new Error(`gemini ${res.status}: ${txt.slice(0, 200)}`);
    }

    const json = (await res.json()) as GeminiResponse;

    // Accumulate Gemini's own token accounting BEFORE any early return, so a
    // safety-blocked or empty response still counts toward the bill — those
    // calls are charged for their input just like successful ones.
    this.promptTokens += json.usageMetadata?.promptTokenCount ?? 0;
    this.candidateTokens += json.usageMetadata?.candidatesTokenCount ?? 0;

    const cand = json.candidates?.[0];
    const blocked =
      json.promptFeedback?.blockReason !== undefined ||
      cand?.finishReason === 'SAFETY';
    const text = cand?.content?.parts?.[0]?.text;
    if (!text) {
      return { byId: new Map(), safetyBlocked: blocked };
    }

    return {
      byId: this.parseAligned(text, items),
      safetyBlocked: blocked,
    };
  }

  /**
   * Parse the JSON array; keep only ids present in the input, exactly once.
   * Applies the deterministic normalization layer: unknown `event_type` →
   * 'other', locations dropped when missing `country_code`, `country_code`
   * normalized to ISO alpha-2 (alpha-3 mapped via {@link CountryCodeMapper},
   * a curated supranational code accepted verbatim, unmappable/malformed codes
   * drop the entry), `city`/`region` lower-cased
   * for stable matching keys, ≤3 locations, ≤5 entities.
   */
  private parseAligned(
    text: string,
    items: EnrichmentInput[],
  ): Map<string, ArticleEnrichment> {
    const inputIds = new Set(items.map((i) => i.id));
    const seen = new Set<string>();
    const byId = new Map<string, ArticleEnrichment>();
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      return byId;
    }
    if (!Array.isArray(arr)) return byId;
    for (const row of arr) {
      const r = row as {
        id?: unknown;
        locations?: unknown;
        entities?: unknown;
        event_type?: unknown;
        category?: unknown;
      };
      const id = typeof r.id === 'string' ? r.id : undefined;
      if (!id || !inputIds.has(id) || seen.has(id)) continue; // extra/dup → ignore
      seen.add(id);
      const enrichment: ArticleEnrichment = {
        geo_tags: this.normalizeLocations(r.locations),
        entities: this.normalizeEntities(r.entities),
        event_type: this.coerceEventType(r.event_type),
      };
      // Only ever set with the flag on AND the path in the taxonomy verbatim —
      // an off-taxonomy path is worse than no path, because a consumer cannot
      // tell an invented one from a real one.
      if (this.categoryEnabled && isValidContentCategory(r.category)) {
        enrichment.content_category = r.category;
      }
      byId.set(id, enrichment);
    }
    return byId;
  }

  /**
   * Countries first, supranational scopes after, then truncate to 3.
   *
   * The ≤3 cap truncates in EMISSION order, so if the model listed "EU" ahead
   * of the member states the bloc would evict a specific country — strictly
   * less information. Partitioning here rather than asking the prompt to order
   * them makes the guarantee structural: a prompt instruction is advice, and
   * this one is cheap to enforce in code.
   *
   * Classification happens in ONE pass so an unmappable code warns exactly
   * once. Note the deliberate behaviour change that follows: the old `break` at
   * 3 stopped reading the array, so an unmappable code sitting in position 4+
   * never warned. It does now — the warn is a signal about the model's output,
   * not about what survived the cap, and suppressing it past position 3 was an
   * accident of the loop shape.
   */
  private normalizeLocations(raw: unknown): GeoTag[] {
    if (!Array.isArray(raw)) return [];
    const countries: GeoTag[] = [];
    const supranational: GeoTag[] = [];
    for (const loc of raw) {
      const l = loc as {
        city?: unknown;
        region?: unknown;
        country_code?: unknown;
      };
      const rawCc =
        typeof l.country_code === 'string' ? l.country_code.trim() : '';
      if (!rawCc) continue; // drop malformed entries missing country_code

      // Supranational codes are checked FIRST and accepted verbatim. They can
      // never shadow a country: alpha-2 owns the two-letter space and the only
      // two-letter member, "EU", is ISO-3166-1 exceptionally reserved.
      if (isSupranationalCode(rawCc)) {
        // No city, no region on a bloc-level tag — a consumer keying on city
        // would otherwise get "brussels" standing in for the whole EU.
        supranational.push({ countryCode: rawCc.toUpperCase() });
        continue;
      }

      const countryCode = CountryCodeMapper.toAlpha2(rawCc);
      if (!countryCode) {
        // Model occasionally emits alpha-3 (or garbage) despite the alpha-2
        // instruction — unmappable codes degrade this one geo_tag rather
        // than the whole article (content-level, not infra-level, failure).
        this.logger.warn('tagging_geo_tag_unmappable_country_code', {
          country_code: rawCc,
        });
        continue;
      }
      const tag: GeoTag = { countryCode };
      if (typeof l.city === 'string' && l.city.trim()) {
        tag.city = l.city.trim().toLowerCase();
      }
      if (typeof l.region === 'string' && l.region.trim()) {
        tag.region = l.region.trim().toLowerCase();
      }
      countries.push(tag);
    }
    // ≤3 locations, most-central-first, countries never evicted by a bloc.
    return [...countries, ...supranational].slice(0, 3);
  }

  private normalizeEntities(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const e of raw) {
      if (typeof e !== 'string') continue;
      const v = e.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length >= 5) break; // ≤5 entities
    }
    return out;
  }

  private coerceEventType(raw: unknown): string {
    return typeof raw === 'string' && EVENT_TYPE_SET.has(raw) ? raw : 'other';
  }

  /**
   * `categoryEnabled` is an ARGUMENT rather than a read of `this`, so the prompt
   * stays callable off the prototype with a null receiver — which is how the
   * regression tests below inspect it — and so the flag-off prompt is provably
   * the pre-category one.
   */
  private buildPrompt(
    items: EnrichmentInput[],
    categoryEnabled = false,
  ): string {
    const payload = items.map((i) => ({
      id: i.id,
      title: i.title_en,
      description: i.description_en,
    }));
    return [
      'You extract structured geo/entity/event metadata from English news articles.',
      'Return a JSON array with one object per input article, each having exactly',
      'the fields id, locations, entities, event_type. The id MUST match the input',
      'id verbatim. Include every input id exactly once.',
      '',
      'locations: the places the ARTICLE CONTENT is about — NOT the publisher.',
      // The largest measured geo leak. On the 348-row gold set, 66 rows name a
      // nationality and 29 of those omitted the country it names — under-
      // extraction, not mislabelling, so it costs coverage as well as accuracy.
      // Stated FIRST on purpose: the identical sentence at the END of this
      // block moved the count only 29 -> 25, against 29 -> 26 here plus a
      // cleaner interaction with the rest of the paragraph.
      // "AFTER the central places" is load-bearing: normalizeLocations
      // truncates at 3 in emission order, so a demonym-implied country that
      // came first could evict a more central place.
      'A nationality or demonym names its country, and that country IS a location',
      'of the story: "British" => GB, "Dutch" => NL, "Korean chipmakers" => KR,',
      '"Vietnamese law" => VN. So does a national government or a company the story',
      'identifies with a home country (Samsung => KR). Add these AFTER the central',
      'places, never instead of one.',
      'Each location is {city, region, country_code}. Use canonical ENGLISH names',
      '("Mumbai" not "Bombay", "Munich" not "München"). region is the state/province',
      '("Madhya Pradesh", "Noord-Holland"). country_code is ISO-3166 alpha-2',
      // Deliberately spliced INTO the country_code sentence rather than appended
      // to the block: 'two letters, e.g. IN not IND' is an unqualified absolute
      // that contradicts EUROPE, and by the end of the paragraph the model has
      // already been told two letters. Two lines plus the vocabulary — every
      // token here is paid per article, and this prompt is one batched call in
      // which any addition perturbs event_type and entities too.
      // "multi-country area", NOT "wider region": the word `region` names a
      // FIELD six lines below ("region is a state or province, never a city and
      // never a country"), and that field is the one that already regressed
      // once when this block was lengthened. Reusing the token in a second
      // sense inside the same paragraph is exactly the collision to avoid, and
      // avoiding it costs nothing.
      'UPPERCASE (two letters, e.g. IN not IND, NL not NLD), or — when the story is',
      'about a bloc or multi-country area rather than a country, and listed AFTER the',
      `specific countries — exactly one of: ${Object.keys(SUPRANATIONAL_CODES).join(', ')}.`,
      'Include at most 3',
      'locations, ordered most-central-first; omit the array entries when the',
      'article is about no specific place. Omit city or region',
      'when unknown, but always include country_code. Disambiguate same-named places',
      'from the article context (e.g. there are two Dindoris in India — the context',
      'decides which).',
      // The region field was being filled with a city or a country — `region:
      // seoul`, `region: beijing`, `region: south korea` — on 9 of the 39
      // regions the gold set produced. This drops that to 1.
      //
      // There is deliberately NO dateline rule here. HEAD adopts 0 of the 10
      // datelines in the gold set, so there is nothing to win, and an arm that
      // quoted two real datelines as negative examples went on to adopt 2:
      // naming the failure mode taught the model to commit it.
      'Never emit a city or region the text does not name: a nationally-scoped',
      'story carries country_code alone, and region is a state or province, never',
      'a city and never a country.',
      '',
      'entities: at most 5 canonical English proper nouns (people, organizations,',
      'products) central to the article. Omit generic nouns.',
      '',
      // The list alone was the whole instruction until 2026-08-09, and an
      // undefined label falls back to the model's own priors. Measured
      // consequence: security advisories (CVEs, vulnerability disclosures,
      // breach write-ups) came back `crime`, because "hacking" reads as
      // criminal. On a 348-article sample that was 4 of 25 rows carrying the
      // label. Downstream consumers treat event_type as a routing key, so a
      // systematically wrong label is worse than `other`. Only the genuinely
      // ambiguous labels are defined below; the self-evident ones are not, to
      // keep the prompt short — every extra token here is paid per article.
      `event_type: exactly one of ${EVENT_TYPES.join(', ')}. Use 'other' when none fit.`,
      'Disambiguation, in priority order when an article could take two labels:',
      '- crime: an actual criminal act against people or property, and its',
      '  investigation or prosecution. A software vulnerability, CVE, patch,',
      '  breach disclosure or security advisory is NOT crime — it is science_tech,',
      "  even when an attacker or 'hackers' are mentioned. Use crime only when a",
      // d8b0e39 defined `crime` but left the security carve-out as prose, and
      // it does not survive contact with a longer locations block: adding the
      // two geo sentences above — which never mention event_type — pushed 18
      // security stories back into `crime`. The fields are coupled through one
      // batched prompt, so a geo edit has to be paid for with an event edit.
      // With this line the gold set carries 10 `crime` rows against HEAD's 24,
      // and 14 breach disclosures move to science_tech as d8b0e39 intended.
      '  specific offence against a victim is the subject. A cyberattack, hack,',
      '  data breach or leak is science_tech even when it names a perpetrator.',
      '- conflict: armed conflict, war, terrorism or military action between',
      '  groups or states. Prefer conflict over crime when both could fit.',
      '- policy: government decisions, legislation, regulation and rulings.',
      '  Prefer policy over business for regulatory action against a company.',
      '- science_tech: research, technology, engineering and computer security.',
      '- health: disease, medicine, public health and healthcare provision.',
      '  Prefer health over science_tech for medical research.',
      '- accident: unintentional harm with no attacker. disaster: natural or',
      '  large-scale events. Prefer disaster over accident by scale.',
      '',
      // Gated: with the flag off these two lines are absent and the prompt is
      // byte-identical to the pre-category one. Placed LAST, furthest from the
      // locations block, because every addition to this batched prompt moves
      // fields it never mentions (a category block moved 63 rows' event_type).
      // Short on purpose — the response schema's enum, not this text, is what
      // makes the field valid (prompt alone: 13.5% valid, 77% invented).
      ...(categoryEnabled
        ? [
            'category: the single best-fitting path from the allowed list for the',
            "article's subject. Choose the closest one; never invent a path.",
            '',
          ]
        : []),
      `Articles: ${JSON.stringify(payload)}`,
    ].join('\n');
  }

  /** Model-level terminal detection: 404, NOT_FOUND, or "model … not available".
   * NEVER matches 429/5xx (those stay transient). */
  static isModelUnavailable(status: number, body: string): boolean {
    if (status === 429 || status >= 500) return false;
    if (status === 404) return true;
    return (
      /NOT_FOUND/.test(body) ||
      /model\b.{0,120}?\b(is\s+)?(not|no longer)\s+(available|found|supported)/i.test(
        body,
      )
    );
  }

  /**
   * Token snapshot for the run summary, with the cost derived from Gemini's own
   * counts rather than from an assumed tokens-per-article ratio. Prices are the
   * published `gemini-3.1-flash-lite` rates, matching the default primary
   * above. Nothing derives them from the configured model id, so a model swap
   * that leaves them behind silently misreports every run — and any older
   * per-1,000-articles estimate was built on the 2.5-flash-lite rates and is
   * not comparable to what this now emits.
   */
  usageStats(): {
    promptTokens: number;
    candidateTokens: number;
    estimatedCostUsd: number;
  } {
    const INPUT_USD_PER_TOKEN = 0.25 / 1_000_000;
    const OUTPUT_USD_PER_TOKEN = 1.5 / 1_000_000;
    return {
      promptTokens: this.promptTokens,
      candidateTokens: this.candidateTokens,
      estimatedCostUsd:
        this.promptTokens * INPUT_USD_PER_TOKEN +
        this.candidateTokens * OUTPUT_USD_PER_TOKEN,
    };
  }

  /** Block-rate snapshot for the run summary. */
  blockStats(): { requests: number; safetyBlocks: number } {
    return { requests: this.requests, safetyBlocks: this.safetyBlocks };
  }
}

/** Internal marker for retryable Gemini failures (429/5xx/network). */
class TransientGeminiError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransientGeminiError';
  }
}

/** Model-level terminal failure (retired/unknown model) — triggers chain failover. */
class ModelUnavailableError extends Error {
  constructor(
    readonly model: string,
    message: string,
  ) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}
