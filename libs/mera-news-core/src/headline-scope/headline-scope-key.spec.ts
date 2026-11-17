import { toHeadlineScopeKey, GLOBAL_SCOPE_KEY } from './headline-scope-key';

describe('toHeadlineScopeKey', () => {
  // The bug this helper exists for: editions are written with alpha-3 keys
  // (publication-source.country_code), the app sends alpha-2, and the old code
  // only uppercased — so every country scope missed and fell through to the
  // live aggregation.
  it.each([
    ['NL', 'NLD'],
    ['IN', 'IND'],
    ['ES', 'ESP'],
    ['PT', 'PRT'],
    ['GB', 'GBR'],
  ])('converts alpha-2 %s to the alpha-3 edition key %s', (input, expected) => {
    expect(toHeadlineScopeKey(input)).toBe(expected);
  });

  it('passes a valid alpha-3 code through unchanged', () => {
    expect(toHeadlineScopeKey('NLD')).toBe('NLD');
  });

  it('lower-cases and pads are normalized before conversion', () => {
    expect(toHeadlineScopeKey('  nl  ')).toBe('NLD');
    expect(toHeadlineScopeKey('nld')).toBe('NLD');
  });

  it.each([null, undefined, '', '   '])(
    'treats %p as the GLOBAL scope',
    (input) => {
      expect(toHeadlineScopeKey(input)).toBe(GLOBAL_SCOPE_KEY);
    },
  );

  it('passes the GLOBAL sentinel through in either case', () => {
    expect(toHeadlineScopeKey('GLOBAL')).toBe(GLOBAL_SCOPE_KEY);
    expect(toHeadlineScopeKey('global')).toBe(GLOBAL_SCOPE_KEY);
  });

  it('falls back to the uppercased input when the code is unmappable', () => {
    // Preserves the pre-fix behaviour (a miss, then the live aggregation)
    // rather than throwing on junk.
    expect(toHeadlineScopeKey('ZZ')).toBe('ZZ');
    expect(toHeadlineScopeKey('nonsense')).toBe('NONSENSE');
  });

  it('never returns an alpha-2 code for a country that has an edition', () => {
    // The assertion that would have caught the original bug directly.
    for (const alpha2 of ['NL', 'IN', 'ES', 'PT', 'GB', 'DE', 'FR', 'BR']) {
      expect(toHeadlineScopeKey(alpha2)).toHaveLength(3);
      expect(toHeadlineScopeKey(alpha2)).not.toBe(alpha2);
    }
  });
});
