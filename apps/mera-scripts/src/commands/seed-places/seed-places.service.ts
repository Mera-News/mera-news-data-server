import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation, Model } from 'mongoose';
import { promises as fs } from 'node:fs';
import { Place, PlaceDocument } from '@mera/models/models/place.model';

export interface SeedPlacesOptions {
  file: string;
  admin1File?: string;
  dryRun?: boolean;
  limit?: number;
}

// GeoNames `cities15000` column indexes (tab-separated).
const COL_GEONAMEID = 0;
const COL_NAME = 1;
const COL_ASCIINAME = 2;
const COL_ALTERNATENAMES = 3;
const COL_LATITUDE = 4;
const COL_LONGITUDE = 5;
const COL_COUNTRY_CODE = 8;
const COL_ADMIN1_CODE = 10;
const COL_POPULATION = 14;

const BULK_CHUNK = 1000;

export const PLACE_DATA_ATTRIBUTION =
  'Place names from GeoNames (https://www.geonames.org), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).';

// search_keys tuning.
const MAX_ALTERNATES = 8; // per-row cap on Latin alternate names considered
const MAX_SEARCH_KEYS = 25; // per-doc cap on total search keys
const MIN_KEY_LENGTH = 3; // skip suffixes shorter than this

// Latin-only guard for alternate names: Basic Latin letters/digits plus
// Latin-1 Supplement / Latin Extended-A & -B (À-ɏ), spaces, hyphens,
// apostrophes and periods. Rejects CJK / Cyrillic / Arabic / etc.
const LATIN_ONLY = /^[A-Za-z0-9À-ɏ .'-]+$/;

// alt_names for the enrichment gazetteer: plain-ASCII Latin names of 4+ chars
// (the rule the enrichment bake-off matched on), deduped case-insensitively.
const GAZETTEER_ALT_NAME = /^[A-Za-z][A-Za-z .'-]{3,}$/;
const MAX_ALT_NAMES = 25;

/** Latin alternate names the enrichment gazetteer matches model output on. */
function buildAltNames(alternatenames: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of alternatenames.split(',')) {
    const a = raw.trim();
    if (!GAZETTEER_ALT_NAME.test(a)) continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
    if (out.length >= MAX_ALT_NAMES) break;
  }
  return out;
}

/**
 * Word-boundary suffixes of `text`, lowercased. "Vila de Porto Santo" →
 * ["vila de porto santo", "de porto santo", "porto santo", "santo"]. Skips
 * 1-char words as suffix starts and drops suffixes shorter than MIN_KEY_LENGTH.
 */
function wordSuffixes(text: string): string[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i].length <= 1) continue; // skip 1-char words as suffix starts
    const suffix = words.slice(i).join(' ');
    if (suffix.length >= MIN_KEY_LENGTH) out.push(suffix);
  }
  return out;
}

/**
 * Build the deduped, lowercased search_keys for a place: word-suffixes of the
 * ascii name + the shortest Latin alternate names + the human region name,
 * always including `normalized` itself. Ordered so the most important keys
 * (normalized, name, region) survive the MAX_SEARCH_KEYS cap ahead of the
 * long-tail alternates.
 */
function buildSearchKeys(
  normalized: string,
  asciiname: string,
  alternatenames: string,
  region?: string,
): string[] {
  const keys = new Set<string>();
  keys.add(normalized);
  for (const s of wordSuffixes(asciiname)) keys.add(s);
  if (region) for (const s of wordSuffixes(region)) keys.add(s);

  const alternates = alternatenames
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && LATIN_ONLY.test(a))
    .sort((a, b) => a.length - b.length) // prefer shorter names
    .slice(0, MAX_ALTERNATES);
  for (const alt of alternates) {
    for (const s of wordSuffixes(alt)) keys.add(s);
  }

  return Array.from(keys).slice(0, MAX_SEARCH_KEYS);
}

@Injectable()
export class SeedPlacesService {
  private readonly logger = new Logger(SeedPlacesService.name);

  constructor(
    @InjectModel(Place.name)
    private readonly placeModel: Model<PlaceDocument>,
  ) {}

  async run(options: SeedPlacesOptions): Promise<void> {
    if (!options.file) {
      throw new Error('--file <path> is required (GeoNames cities15000 file)');
    }

    const admin1 = options.admin1File
      ? await this.loadAdmin1Names(options.admin1File)
      : new Map<string, string>();
    if (options.admin1File) {
      this.logger.log(`Loaded ${admin1.size} admin1 human names`);
    }

    const raw = await fs.readFile(options.file, 'utf8');
    const lines = raw.split('\n');

    const ops: AnyBulkWriteOperation<PlaceDocument>[] = [];
    let parsed = 0;
    let skipped = 0;
    let written = 0;

    for (const line of lines) {
      if (options.limit != null && parsed >= options.limit) break;
      if (!line.trim()) continue;

      const cols = line.split('\t');
      const geonameIdRaw = cols[COL_GEONAMEID]?.trim();
      const name = cols[COL_NAME]?.trim();
      const asciiname = cols[COL_ASCIINAME]?.trim() || name;
      const alternatenames = cols[COL_ALTERNATENAMES]?.trim() ?? '';
      const countryCode = cols[COL_COUNTRY_CODE]?.trim();
      const admin1Code = cols[COL_ADMIN1_CODE]?.trim();
      const populationRaw = cols[COL_POPULATION]?.trim();
      const latitudeRaw = cols[COL_LATITUDE]?.trim();
      const longitudeRaw = cols[COL_LONGITUDE]?.trim();

      if (!name || !countryCode) {
        skipped++;
        continue;
      }

      const region = admin1Code
        ? (admin1.get(`${countryCode}.${admin1Code}`) ?? admin1Code)
        : undefined;
      const population = populationRaw
        ? parseInt(populationRaw, 10)
        : undefined;
      // GeoNames ships decimal degrees in columns 4 and 5. Parsed with
      // parseFloat, then finite-checked below exactly like `population` --
      // parseFloat('') and parseFloat('n/a') are NaN, and NaN stored in Mongo
      // is a number, not a null, so it would read back as a coordinate and
      // point a lookup at nowhere.
      const latitude = latitudeRaw ? parseFloat(latitudeRaw) : undefined;
      const longitude = longitudeRaw ? parseFloat(longitudeRaw) : undefined;
      const geonameId = geonameIdRaw ? parseInt(geonameIdRaw, 10) : undefined;
      const normalized = asciiname.toLowerCase();
      const displayName = region
        ? `${name}, ${region}, ${countryCode}`
        : `${name}, ${countryCode}`;
      const search_keys = buildSearchKeys(
        normalized,
        asciiname,
        alternatenames,
        region,
      );

      parsed++;
      ops.push({
        updateOne: {
          // Upsert identity: a place is unique per (normalized, country, region).
          filter: { normalized, countryCode, region: region ?? null },
          update: {
            $set: {
              city: name,
              region,
              countryCode,
              displayName,
              normalized,
              search_keys,
              population: Number.isFinite(population) ? population : undefined,
              // Additive: adding two keys to this `$set` and re-running is an
              // idempotent, in-place field addition on the existing rows. The
              // filter below is unchanged, so no row is recreated and no _id
              // churns; rows seeded before these columns existed simply gain
              // them on the next run.
              latitude: Number.isFinite(latitude) ? latitude : undefined,
              longitude: Number.isFinite(longitude) ? longitude : undefined,
              // Same additive pattern: read by the article-enrichment
              // gazetteer. The upsert filter stays (normalized, country,
              // region), so two GeoNames rows sharing all three still fold
              // into one place and the last one's id wins.
              geonameId: Number.isFinite(geonameId) ? geonameId : undefined,
              alt_names: buildAltNames(alternatenames),
            },
          },
          upsert: true,
        },
      });

      if (ops.length >= BULK_CHUNK && !options.dryRun) {
        written += await this.flush(ops);
        ops.length = 0;
      }
    }

    if (options.dryRun) {
      this.logger.log(
        `[dry-run] parsed=${parsed} skipped=${skipped} would-upsert=${ops.length} (chunked), no writes`,
      );
      return;
    }

    if (ops.length > 0) {
      written += await this.flush(ops);
    }

    this.logger.log(
      `seed-places done: parsed=${parsed} skipped=${skipped} upserted/updated=${written}`,
    );
    this.logger.log(PLACE_DATA_ATTRIBUTION);
  }

  private async flush(
    ops: AnyBulkWriteOperation<PlaceDocument>[],
  ): Promise<number> {
    const res = await this.placeModel.bulkWrite(ops, { ordered: false });
    return (res.upsertedCount ?? 0) + (res.modifiedCount ?? 0);
  }

  /**
   * Parse GeoNames `admin1CodesASCII.txt`: `COUNTRY.ADMIN1\tName\tasciiName\tid`.
   * Returns a `${country}.${admin1}` → human name map.
   */
  private async loadAdmin1Names(path: string): Promise<Map<string, string>> {
    const raw = await fs.readFile(path, 'utf8');
    const map = new Map<string, string>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const cols = line.split('\t');
      const key = cols[0]?.trim();
      const name = cols[1]?.trim();
      if (key && name) map.set(key, name);
    }
    return map;
  }
}
