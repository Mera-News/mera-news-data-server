import { CountryCodeMapper } from '../profile-serializer/country-code-mapper';
import type { GeoTag } from './article-enrichment-provider.port';

/**
 * In-memory place canonicaliser over the `places` collection (GeoNames
 * cities15000 + admin1 human names, loaded by the `seed-places` script).
 * Ported from `canonicalize` in
 * apps/mera-scripts/eval-data/enrichment-bakeoff/lib/gazetteer.mjs.
 *
 * The model names the place; this only maps that name onto a canonical row so
 * the tag carries a lower-case canonical city, its region and, when the row
 * has one, the GeoNames id. `geonameId` and `alt_names` are optional on the
 * rows: a collection seeded before those columns existed still canonicalises
 * names, it just yields no ids.
 *
 * Never indexes `search_keys`: those are word suffixes for the typeahead
 * ("santo" for Vila de Porto Santo, "york" for New York) and would resolve an
 * unrelated town.
 */

/** The minimal `places` projection the gazetteer needs. */
export interface PlaceRow {
  city: string;
  normalized?: string;
  region?: string | null;
  countryCode: string;
  population?: number | null;
  geonameId?: number | null;
  alt_names?: string[] | null;
}

/** A place as the model emitted it. */
export interface RawPlace {
  city?: unknown;
  region?: unknown;
  country?: unknown;
}

const MIN_NAME_KEY = 4;

/** Latin alternate names only, 4+ chars, as in the bake-off index. */
const LATIN_ALT = /^[A-Za-z][A-Za-z .'-]{3,}$/;

/**
 * Title-cased words that are also city names but almost always mean something
 * else in English news. Carried over from the bake-off verbatim.
 */
// prettier-ignore
const STOP = new Set([
  'mobile', 'split', 'bath', 'reading', 'deal', 'march', 'nice', 'victoria',
  'university', 'independence', 'liberty', 'union', 'progress', 'hope',
  'mercedes', 'santa', 'san', 'saint', 'city', 'north', 'south', 'east',
  'west', 'central', 'new', 'prince', 'president', 'commerce', 'republic',
  'police', 'media', 'of', 'the', 'and', 'june', 'july', 'may', 'august',
  'university city', 'orange', 'sale', 'best', 'bristol bay', 'mansfield',
  'kingston upon hull', 'lincoln', 'washington post', 'york', 'hamilton',
  'darwin', 'wellington', 'jackson', 'florence', 'regina', 'laval', 'carmen',
  'roma', 'paris hilton', 'kent', 'essex', 'delta', 'ocean', 'temple',
  'marina', 'valencia cf',
]);

/**
 * Codes the model emits that the ISO library does not validate. Kosovo is a
 * user-assigned code in wide use; "UK" is the common misspelling of GB.
 */
const COUNTRY_OVERRIDES: Readonly<Record<string, string>> = {
  XK: 'XK',
  UK: 'GB',
};

export function normPlaceName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Uppercase ISO alpha-2 for a model-emitted country code, or null. */
export function toPlaceCountryCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const up = raw.trim().toUpperCase();
  if (COUNTRY_OVERRIDES[up]) return COUNTRY_OVERRIDES[up];
  return CountryCodeMapper.toAlpha2(up);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export class PlaceGazetteer {
  private readonly byName = new Map<string, PlaceRow[]>();
  private readonly regionByName = new Map<
    string,
    { cc: string; name: string }[]
  >();

  private constructor(rows: PlaceRow[]) {
    for (const row of rows) {
      if (!row.city || !row.countryCode) continue;
      const names = new Set<string>([row.city]);
      if (row.normalized) names.add(row.normalized);
      for (const a of row.alt_names ?? []) {
        if (LATIN_ALT.test(a)) names.add(a);
      }
      for (const n of names) {
        const k = normPlaceName(n);
        if (k.length < MIN_NAME_KEY || STOP.has(k)) continue;
        const list = this.byName.get(k);
        if (!list) this.byName.set(k, [row]);
        else if (!list.includes(row)) list.push(row);
      }
      if (row.region) {
        const k = normPlaceName(row.region);
        if (k.length >= MIN_NAME_KEY) {
          const list = this.regionByName.get(k) ?? [];
          if (!list.some((r) => r.cc === row.countryCode)) {
            list.push({ cc: row.countryCode, name: row.region });
          }
          this.regionByName.set(k, list);
        }
      }
    }
    for (const list of this.byName.values()) {
      list.sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
    }
  }

  static fromRows(rows: PlaceRow[]): PlaceGazetteer {
    return new PlaceGazetteer(rows);
  }

  get size(): number {
    return this.byName.size;
  }

  /**
   * city(+country) → the most populous matching row; else region(+country) →
   * the admin1 name; else a valid country keeps the model's own names without
   * an id. Returns null only when the country itself is not a valid alpha-2
   * (supranational codes are the caller's business, not the gazetteer's).
   */
  canonicalize(place: RawPlace): GeoTag | null {
    const cc = toPlaceCountryCode(place.country);
    const city = str(place.city);
    const region = str(place.region);

    if (city) {
      const hit = (this.byName.get(normPlaceName(city)) ?? []).find(
        (r) => !cc || r.countryCode === cc,
      );
      if (hit) {
        const tag: GeoTag = {
          countryCode: hit.countryCode,
          city: normPlaceName(hit.normalized || hit.city),
        };
        if (hit.region) tag.region = normPlaceName(hit.region);
        if (typeof hit.geonameId === 'number') tag.geonameId = hit.geonameId;
        return tag;
      }
    }
    if (!cc) return null;
    if (region) {
      const r = (this.regionByName.get(normPlaceName(region)) ?? []).find(
        (x) => x.cc === cc,
      );
      if (r) return { countryCode: cc, region: normPlaceName(r.name) };
    }
    const tag: GeoTag = { countryCode: cc };
    if (city) tag.city = normPlaceName(city);
    if (region) tag.region = normPlaceName(region);
    return tag;
  }
}

/**
 * Loads the gazetteer once, on first use, and memoises it. A failed load is
 * not cached, so the next batch retries it. Lazy on purpose: only the async
 * worker's enrichment path ever needs `places`, and a bootstrap-time load
 * would make every app that imports the provider module pay for it.
 */
export class LazyPlaceGazetteer {
  private pending: Promise<PlaceGazetteer> | null = null;

  constructor(private readonly loadRows: () => Promise<PlaceRow[]>) {}

  get(): Promise<PlaceGazetteer> {
    if (!this.pending) {
      this.pending = this.loadRows()
        .then((rows) => PlaceGazetteer.fromRows(rows))
        .catch((err: unknown) => {
          this.pending = null;
          throw err;
        });
    }
    return this.pending;
  }
}
