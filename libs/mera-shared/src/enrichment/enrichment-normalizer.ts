/**
 * Code-side post-validation of the OpenAI-compatible adapter's output. The
 * model's JSON is never trusted: every closed vocabulary is enforced here, a
 * category path is snapped onto the NLP tree, and a place is canonicalised
 * against the `places` gazetteer. Ported from `normalizeBatch` /
 * `extractJsonText` in apps/mera-scripts/eval-data/enrichment-bakeoff/lib.
 */
import type {
  ArticleEnrichment,
  EnrichmentOutput,
  GeoTag,
} from './article-enrichment-provider.port';
import { EVENT_TYPES } from './gemini-enrichment.service';
import {
  GEO_SCOPE_DESCRIPTIONS,
  GENRE_DESCRIPTIONS,
  TONE_DESCRIPTIONS,
} from './enrichment-spec';
import { normalizeCategoryPaths } from './category-snap';
import { isSupranationalCode } from './supranational-codes';
import type { PlaceGazetteer } from './place-gazetteer';

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);
const MAX_PLACES = 3;
const MAX_ENTITIES = 5;

/**
 * Unwrap the ways a model wraps the requested array: a leaked reasoning trace,
 * a code fence, a wrapping object with exactly one array value, or prose
 * around the array (the outermost `[...]` is taken if it parses). Returns the
 * text to `JSON.parse`; it may still not be an array.
 */
export function extractJsonText(text: string | null | undefined): string {
  let t = text ?? '';
  const think = t.lastIndexOf('</think>');
  if (think >= 0) t = t.slice(think + '</think>'.length);
  t = t
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');
  try {
    const parsed: unknown = JSON.parse(t);
    if (!Array.isArray(parsed) && parsed && typeof parsed === 'object') {
      const arrays = Object.values(parsed).filter(Array.isArray);
      if (arrays.length === 1) return JSON.stringify(arrays[0]);
    }
  } catch {
    const a = t.indexOf('[');
    const b = t.lastIndexOf(']');
    if (a >= 0 && b > a) {
      try {
        JSON.parse(t.slice(a, b + 1));
        return t.slice(a, b + 1);
      } catch {
        // fall through: the caller sees a non-array and treats it as a miss
      }
    }
  }
  return t;
}

/**
 * Parse the model text to an id → raw row map, keeping only ids that are in
 * the input, each at most once (a duplicate or unknown id is ignored). Ids are
 * compared as strings, so a model that echoes an id as a number still aligns.
 * Returns null when the text is not a JSON array at all.
 */
export function parseAlignedRows(
  text: string | null | undefined,
  inputIds: ReadonlySet<string>,
): Map<string, Record<string, unknown>> | null {
  let arr: unknown;
  try {
    arr = JSON.parse(extractJsonText(text));
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id =
      typeof r.id === 'string' || typeof r.id === 'number'
        ? String(r.id)
        : undefined;
    if (!id || !inputIds.has(id) || byId.has(id)) continue;
    byId.set(id, r);
  }
  return byId;
}

function oneOf<T extends object>(vocab: T, v: unknown): string | undefined {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(vocab, v)
    ? v
    : undefined;
}

function normalizeEntities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of raw) {
    if (typeof e !== 'string') continue;
    const v = e.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_ENTITIES) break;
  }
  return out;
}

/**
 * Places → geo_tags. Supranational codes are accepted verbatim with no city or
 * region, except GLOBAL, which is a query-scope sentinel and never an article
 * attribute. Everything else goes through the gazetteer; a place whose country
 * is not a valid alpha-2 is dropped. Countries come before supranational codes
 * so the cap of 3 can never let a bloc evict a specific country. The
 * publisher's country is never added here: only what the model named.
 */
export function normalizePlaces(
  raw: unknown,
  gazetteer: PlaceGazetteer,
): GeoTag[] {
  if (!Array.isArray(raw)) return [];
  const countries: GeoTag[] = [];
  const blocs: GeoTag[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const place = p as { city?: unknown; region?: unknown; country?: unknown };
    const country =
      typeof place.country === 'string' ? place.country.trim() : '';
    let tag: GeoTag | null;
    let bucket: GeoTag[];
    if (country && isSupranationalCode(country)) {
      const code = country.toUpperCase();
      if (code === 'GLOBAL') continue;
      tag = { countryCode: code };
      bucket = blocs;
    } else {
      tag = gazetteer.canonicalize(place);
      bucket = countries;
    }
    if (!tag) continue;
    const key = `${tag.countryCode}|${tag.region ?? ''}|${tag.city ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bucket.push(tag);
  }
  return [...countries, ...blocs].slice(0, MAX_PLACES);
}

/** One raw model row → a validated enrichment. */
export function normalizeRow(
  raw: Record<string, unknown>,
  gazetteer: PlaceGazetteer,
  categoryEnabled: boolean,
): ArticleEnrichment {
  const geoScope = oneOf(GEO_SCOPE_DESCRIPTIONS, raw.geo_scope);
  const categories = normalizeCategoryPaths(raw.categories);
  const sig =
    typeof raw.significance === 'number' ||
    (typeof raw.significance === 'string' &&
      /^\s*\d\s*$/.test(raw.significance))
      ? Number(raw.significance)
      : NaN;
  const out: ArticleEnrichment = {
    geo_tags:
      geoScope === 'global' ? [] : normalizePlaces(raw.places, gazetteer),
    entities: normalizeEntities(raw.entities),
    event_type:
      typeof raw.event_type === 'string' && EVENT_TYPE_SET.has(raw.event_type)
        ? raw.event_type
        : 'other',
    content_categories: categories,
  };
  if (categoryEnabled && categories[0]) out.content_category = categories[0];
  if (geoScope) out.geo_scope = geoScope;
  const genre = oneOf(GENRE_DESCRIPTIONS, raw.genre);
  if (genre) out.genre = genre;
  const tone = oneOf(TONE_DESCRIPTIONS, raw.tone);
  if (tone) out.tone = tone;
  if (Number.isInteger(sig) && sig >= 1 && sig <= 5) {
    out.significance = sig;
  }
  return out;
}

/** The degraded row: a real answer meaning "nothing usable". */
export function degradedEnrichment(id: string): EnrichmentOutput {
  return {
    id,
    geo_tags: [],
    entities: [],
    event_type: 'other',
    content_categories: [],
  };
}
