import {
  degradedEnrichment,
  extractJsonText,
  normalizePlaces,
  normalizeRow,
  parseAlignedRows,
} from './enrichment-normalizer';
import { PlaceGazetteer } from './place-gazetteer';

const gazetteer = PlaceGazetteer.fromRows([
  {
    city: 'Kyiv',
    normalized: 'kyiv',
    region: 'Kyiv City',
    countryCode: 'UA',
    population: 2797553,
    geonameId: 703448,
  },
  {
    city: 'Brussels',
    normalized: 'brussels',
    region: 'Brussels Capital',
    countryCode: 'BE',
    population: 1019022,
    geonameId: 2800866,
  },
]);

describe('extractJsonText', () => {
  it('passes a bare array through', () => {
    expect(JSON.parse(extractJsonText('[{"id":"a"}]'))).toEqual([{ id: 'a' }]);
  });

  it('strips a code fence', () => {
    expect(JSON.parse(extractJsonText('```json\n[{"id":"a"}]\n```'))).toEqual([
      { id: 'a' },
    ]);
  });

  it('unwraps an object holding exactly one array', () => {
    expect(JSON.parse(extractJsonText('{"articles":[{"id":"a"}]}'))).toEqual([
      { id: 'a' },
    ]);
  });

  it('takes the outermost array out of surrounding prose', () => {
    expect(
      JSON.parse(extractJsonText('Here is the output:\n[{"id":"a"}]\nDone.')),
    ).toEqual([{ id: 'a' }]);
  });

  it('drops a leaked reasoning trace', () => {
    expect(
      JSON.parse(extractJsonText('<think>hmm [x]</think>[{"id":"a"}]')),
    ).toEqual([{ id: 'a' }]);
  });

  it('leaves unparseable text alone and tolerates null', () => {
    expect(extractJsonText('not json')).toBe('not json');
    expect(extractJsonText(null)).toBe('');
  });
});

describe('parseAlignedRows', () => {
  const ids = new Set(['a', 'b', '7']);

  it('keeps input ids once, ignores extras and duplicates, aligns numeric ids', () => {
    const rows = parseAlignedRows(
      JSON.stringify([
        { id: 'a', n: 1 },
        { id: 'a', n: 2 },
        { id: 'zzz' },
        { id: 7 },
        null,
        'junk',
      ]),
      ids,
    );
    expect(rows && [...rows.keys()]).toEqual(['a', '7']);
    expect(rows?.get('a')).toEqual({ id: 'a', n: 1 });
  });

  it('returns null for a non-array reply', () => {
    expect(parseAlignedRows('{"id":"a"}', ids)).toBeNull();
    expect(parseAlignedRows('oops', ids)).toBeNull();
  });
});

describe('normalizePlaces', () => {
  it('canonicalises, keeps countries before blocs, drops GLOBAL, dedupes and caps at 3', () => {
    expect(
      normalizePlaces(
        [
          { city: null, region: null, country: 'EU' },
          { city: null, region: null, country: 'GLOBAL' },
          { city: 'Kyiv', region: null, country: 'UA' },
          { city: 'Kyiv', region: null, country: 'UA' },
          { city: 'Brussels', region: null, country: 'BE' },
          { city: null, region: null, country: 'PL' },
        ],
        gazetteer,
      ),
    ).toEqual([
      {
        countryCode: 'UA',
        city: 'kyiv',
        region: 'kyiv city',
        geonameId: 703448,
      },
      {
        countryCode: 'BE',
        city: 'brussels',
        region: 'brussels capital',
        geonameId: 2800866,
      },
      { countryCode: 'PL' },
    ]);
  });

  it('keeps a bloc with no city or region and drops an invalid country', () => {
    expect(
      normalizePlaces(
        [
          { city: 'Brussels', country: 'eu' },
          { city: 'Nowhere', country: 'ZZ' },
          'junk',
        ],
        gazetteer,
      ),
    ).toEqual([{ countryCode: 'EU' }]);
    expect(normalizePlaces(undefined, gazetteer)).toEqual([]);
  });
});

describe('normalizeRow', () => {
  const full = {
    id: 'a',
    event_type: 'conflict',
    categories: ['/News/Politics', '/news'],
    geo_scope: 'city',
    places: [{ city: 'Kyiv', region: null, country: 'UA' }],
    entities: ['Volodymyr Zelensky', ' ', 'Volodymyr Zelensky', 3, 'NATO'],
    genre: 'news',
    tone: 'distressing',
    significance: 4,
  };

  it('maps a valid row', () => {
    expect(normalizeRow(full, gazetteer, false)).toEqual({
      geo_tags: [
        {
          countryCode: 'UA',
          city: 'kyiv',
          region: 'kyiv city',
          geonameId: 703448,
        },
      ],
      entities: ['Volodymyr Zelensky', 'NATO'],
      event_type: 'conflict',
      content_categories: ['/News/Politics'],
      geo_scope: 'city',
      genre: 'news',
      tone: 'distressing',
      significance: 4,
    });
  });

  it('writes content_category only while the flag is on', () => {
    expect(normalizeRow(full, gazetteer, true).content_category).toBe(
      '/News/Politics',
    );
    expect(
      normalizeRow({ ...full, categories: [] }, gazetteer, true),
    ).not.toHaveProperty('content_category');
  });

  it('enforces every closed vocabulary', () => {
    const out = normalizeRow(
      {
        event_type: 'war',
        geo_scope: 'planet',
        genre: 'blog',
        tone: 'angry',
        significance: 9,
        categories: 'nope',
        places: 'nope',
        entities: 'nope',
      },
      gazetteer,
      true,
    );
    expect(out).toEqual({
      geo_tags: [],
      entities: [],
      event_type: 'other',
      content_categories: [],
    });
  });

  it('accepts a digit-string significance and rejects fractions, booleans and blanks', () => {
    const sig = (v: unknown) =>
      normalizeRow({ ...full, significance: v }, gazetteer, false).significance;
    expect(sig('3')).toBe(3);
    expect(sig(2.5)).toBeUndefined();
    expect(sig(true)).toBeUndefined();
    expect(sig('')).toBeUndefined();
    expect(sig(null)).toBeUndefined();
    expect(sig(0)).toBeUndefined();
  });

  it('geo_scope global writes no places', () => {
    expect(
      normalizeRow({ ...full, geo_scope: 'global' }, gazetteer, false).geo_tags,
    ).toEqual([]);
  });

  it('degraded row is the documented empty answer', () => {
    expect(degradedEnrichment('x')).toEqual({
      id: 'x',
      geo_tags: [],
      entities: [],
      event_type: 'other',
      content_categories: [],
    });
  });
});
