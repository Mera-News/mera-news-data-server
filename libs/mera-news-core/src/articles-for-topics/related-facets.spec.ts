import {
  normalizeRelatedCountry,
  normalizeRelatedLanguage,
  toRelatedFilters,
} from './related-facets';

describe('related-facets normalizers', () => {
  it.each([
    ['zh-Hans', 'zh'],
    ['zh_TW', 'zh'],
    [' EN-gb ', 'en'],
    ['de', 'de'],
    ['', null],
    [null, null],
  ])('language %p -> %p', (input, expected) => {
    expect(normalizeRelatedLanguage(input)).toBe(expected);
  });

  it.each([
    ['deu', 'DEU'],
    [' GLOBAL ', 'GLOBAL'],
    ['', null],
    [undefined, null],
  ])('country %p -> %p', (input, expected) => {
    expect(normalizeRelatedCountry(input)).toBe(expected);
  });

  it('turns absent, empty and blank-only lists into "no filter"', () => {
    expect(toRelatedFilters(null, undefined)).toEqual({
      countries: null,
      languages: null,
    });
    expect(toRelatedFilters([], ['  '])).toEqual({
      countries: null,
      languages: null,
    });
  });

  it('normalizes filter values the same way as the facets', () => {
    const f = toRelatedFilters(['deu', 'DEU'], ['de-AT']);
    expect(Array.from(f.countries ?? [])).toEqual(['DEU']);
    expect(Array.from(f.languages ?? [])).toEqual(['de']);
  });
});
