import {
  APPLE_CATEGORY_MAP,
  APPLE_IGNORED_NAV_IDS,
  APPLE_TYPE_NAV_IDS,
  PUBLICATION_CATEGORIES,
  PUBLICATION_TYPES,
  coercePublicationCategories,
  coercePublicationType,
} from './publication-taxonomy';

describe('coercePublicationType', () => {
  it('returns undefined for undefined (unclassified, not "other")', () => {
    expect(coercePublicationType(undefined)).toBeUndefined();
  });

  it('returns undefined for null (unclassified, not "other")', () => {
    expect(coercePublicationType(null)).toBeUndefined();
  });

  it('returns undefined for an empty string (unclassified, not "other")', () => {
    expect(coercePublicationType('')).toBeUndefined();
  });

  it('round-trips a valid slug', () => {
    expect(coercePublicationType('newspaper')).toBe('newspaper');
    expect(coercePublicationType('wire_agency')).toBe('wire_agency');
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(coercePublicationType('Newspaper')).toBe('newspaper');
  });

  it('normalizes hyphens/spaces to underscores against a slug that actually has one', () => {
    expect(coercePublicationType(' wire-agency ')).toBe('wire_agency');
    expect(coercePublicationType('WIRE AGENCY')).toBe('wire_agency');
  });

  it('a hyphen inserted where the canonical slug has none still misses (normalizes to "news_paper", not "newspaper")', () => {
    expect(coercePublicationType(' news-paper ')).toBe('other');
  });

  it('coerces an unrecognized non-empty value to "other"', () => {
    expect(coercePublicationType('podcast')).toBe('other');
  });
});

describe('coercePublicationCategories', () => {
  it('returns undefined for a non-array value', () => {
    expect(coercePublicationCategories(undefined)).toBeUndefined();
    expect(coercePublicationCategories(null)).toBeUndefined();
    expect(coercePublicationCategories('news_politics')).toBeUndefined();
  });

  it('returns undefined for an empty array', () => {
    expect(coercePublicationCategories([])).toBeUndefined();
  });

  it('coerces an unknown slug to "other"', () => {
    expect(coercePublicationCategories(['underwater_basket_weaving'])).toEqual([
      'other',
    ]);
  });

  it('dedupes, preserving first-seen order', () => {
    expect(
      coercePublicationCategories(['sports', 'business', 'sports', 'Business']),
    ).toEqual(['sports', 'business']);
  });

  it('returns undefined for an array of only empty strings', () => {
    expect(coercePublicationCategories(['', '', ''])).toBeUndefined();
  });

  it('normalizes case/whitespace/hyphens the same way as the type coercion', () => {
    expect(coercePublicationCategories([' Style-Beauty '])).toEqual([
      'style_beauty',
    ]);
  });

  it('drops null/undefined/empty entries but keeps valid ones', () => {
    expect(
      coercePublicationCategories([null, undefined, '', 'health']),
    ).toEqual(['health']);
  });
});

describe('Apple nav id maps', () => {
  // Union across all four Apple News+ storefronts (US/CA carry `men`/`women`/
  // `kids`/`outdoors`; UK drops `kids`/`outdoors`; AU collapses them into
  // `lifestyle` instead) — 20 distinct nav ids total. Hardcoded rather than
  // derived from APPLE_CATEGORY_MAP so the assertion below actually catches a
  // nav id silently dropped from all three groups, instead of being a tautology.
  const ALL_APPLE_NAV_IDS = [
    'featured',
    'newspapers',
    'news',
    'entertainment',
    'sports',
    'business',
    'style',
    'food',
    'travel',
    'health',
    'home',
    'science',
    'cars',
    'hobbies',
    'men',
    'women',
    'lifestyle',
    'outdoors',
    'kids',
    'new',
  ];

  it('every value of APPLE_CATEGORY_MAP is a known PublicationCategory', () => {
    for (const category of Object.values(APPLE_CATEGORY_MAP)) {
      expect(PUBLICATION_CATEGORIES).toContain(category);
    }
  });

  it('every value of APPLE_TYPE_NAV_IDS is a known PublicationType', () => {
    for (const type of Object.values(APPLE_TYPE_NAV_IDS)) {
      expect(PUBLICATION_TYPES).toContain(type);
    }
  });

  it('"newspapers" is not a key of APPLE_CATEGORY_MAP (it is a type, not a genre)', () => {
    expect(Object.keys(APPLE_CATEGORY_MAP)).not.toContain('newspapers');
    expect(Object.keys(APPLE_TYPE_NAV_IDS)).toContain('newspapers');
  });

  it('"featured" and "new" are ignored and in neither map', () => {
    expect(APPLE_IGNORED_NAV_IDS).toContain('featured');
    expect(APPLE_IGNORED_NAV_IDS).toContain('new');
    for (const id of ['featured', 'new']) {
      expect(Object.keys(APPLE_CATEGORY_MAP)).not.toContain(id);
      expect(Object.keys(APPLE_TYPE_NAV_IDS)).not.toContain(id);
    }
  });

  it('the 20 Apple nav ids are exactly partitioned across the three groups', () => {
    const categoryKeys = Object.keys(APPLE_CATEGORY_MAP);
    const typeKeys = Object.keys(APPLE_TYPE_NAV_IDS);
    const ignored = [...APPLE_IGNORED_NAV_IDS];

    const union = [...categoryKeys, ...typeKeys, ...ignored].sort();
    expect(union).toEqual([...ALL_APPLE_NAV_IDS].sort());

    // Partition (not just a covering union): no id appears in more than one group.
    const allGroups = [categoryKeys, typeKeys, ignored];
    for (const id of ALL_APPLE_NAV_IDS) {
      const memberships = allGroups.filter((group) => group.includes(id));
      expect(memberships).toHaveLength(1);
    }
  });
});
