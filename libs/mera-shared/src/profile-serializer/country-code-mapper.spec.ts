import { CountryCodeMapper } from './country-code-mapper';

describe('CountryCodeMapper.getCountryCode', () => {
  it('returns alpha-3 code for a well-known country name', () => {
    const result = CountryCodeMapper.getCountryCode('Germany');
    expect(result).toBe('DEU');
  });

  it('returns alpha-3 code for USA alias', () => {
    const result = CountryCodeMapper.getCountryCode('USA');
    expect(result).toBe('USA');
  });

  it('returns alpha-3 code for "United States"', () => {
    const result = CountryCodeMapper.getCountryCode('United States');
    expect(result).toBe('USA');
  });

  it('returns alpha-3 code for "United Kingdom" alias', () => {
    const result = CountryCodeMapper.getCountryCode('United Kingdom');
    expect(result).toBe('GBR');
  });

  it('returns alpha-3 code for "UK" alias', () => {
    const result = CountryCodeMapper.getCountryCode('UK');
    expect(result).toBe('GBR');
  });

  it('returns alpha-3 code for "South Korea" alias', () => {
    const result = CountryCodeMapper.getCountryCode('South Korea');
    expect(result).toBe('KOR');
  });

  it('returns alpha-3 code for "India"', () => {
    const result = CountryCodeMapper.getCountryCode('India');
    expect(result).toBe('IND');
  });

  it('is case-insensitive for exact match', () => {
    const upper = CountryCodeMapper.getCountryCode('GERMANY');
    const lower = CountryCodeMapper.getCountryCode('germany');
    expect(upper).toBe('DEU');
    expect(lower).toBe('DEU');
  });

  it('returns null for empty string', () => {
    const result = CountryCodeMapper.getCountryCode('');
    expect(result).toBeNull();
  });

  it('returns null for completely unknown name', () => {
    const result = CountryCodeMapper.getCountryCode('Neverland');
    expect(result).toBeNull();
  });

  it('returns via partial match if name contains a known country', () => {
    // "Republic of India" contains "India"
    const result = CountryCodeMapper.getCountryCode('Republic of India');
    // Should find India via partial or exact; just check not null
    expect(result).not.toBeNull();
  });
});

describe('CountryCodeMapper.getCountryName', () => {
  it('returns country name for alpha-2 code', () => {
    const result = CountryCodeMapper.getCountryName('US');
    expect(result).toBe('United States of America');
  });

  it('returns country name for alpha-3 code', () => {
    const result = CountryCodeMapper.getCountryName('DEU');
    expect(result).toBe('Germany');
  });

  it('is case-insensitive', () => {
    const lower = CountryCodeMapper.getCountryName('de');
    const upper = CountryCodeMapper.getCountryName('DE');
    expect(lower).toBe(upper);
  });

  it('returns null for empty string', () => {
    const result = CountryCodeMapper.getCountryName('');
    expect(result).toBeNull();
  });

  it('returns null for invalid code', () => {
    const result = CountryCodeMapper.getCountryName('XX');
    expect(result).toBeNull();
  });
});

describe('CountryCodeMapper.toAlpha3', () => {
  it('returns alpha-3 for an alpha-2 input', () => {
    expect(CountryCodeMapper.toAlpha3('US')).toBe('USA');
    expect(CountryCodeMapper.toAlpha3('DE')).toBe('DEU');
    expect(CountryCodeMapper.toAlpha3('GB')).toBe('GBR');
  });

  it('returns input alpha-3 unchanged if valid', () => {
    expect(CountryCodeMapper.toAlpha3('IND')).toBe('IND');
    expect(CountryCodeMapper.toAlpha3('GBR')).toBe('GBR');
  });

  it('returns "GLOBAL" for the GLOBAL sentinel', () => {
    expect(CountryCodeMapper.toAlpha3('GLOBAL')).toBe('GLOBAL');
    expect(CountryCodeMapper.toAlpha3('global')).toBe('GLOBAL');
  });

  it('returns null for empty string', () => {
    expect(CountryCodeMapper.toAlpha3('')).toBeNull();
  });

  it('returns null for invalid alpha-2', () => {
    expect(CountryCodeMapper.toAlpha3('XX')).toBeNull();
  });

  it('returns null for invalid alpha-3', () => {
    expect(CountryCodeMapper.toAlpha3('ZZZ')).toBeNull();
  });

  it('returns null for string longer than 3 chars (not GLOBAL)', () => {
    expect(CountryCodeMapper.toAlpha3('USABC')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(CountryCodeMapper.toAlpha3('us')).toBe('USA');
    expect(CountryCodeMapper.toAlpha3('ind')).toBe('IND');
  });
});

describe('CountryCodeMapper.toAlpha2', () => {
  it('returns alpha-2 for an alpha-3 input', () => {
    expect(CountryCodeMapper.toAlpha2('IND')).toBe('IN');
    expect(CountryCodeMapper.toAlpha2('NLD')).toBe('NL');
    expect(CountryCodeMapper.toAlpha2('DEU')).toBe('DE');
    expect(CountryCodeMapper.toAlpha2('PRT')).toBe('PT');
  });

  it('returns input alpha-2 unchanged (uppercased) if valid', () => {
    expect(CountryCodeMapper.toAlpha2('US')).toBe('US');
    expect(CountryCodeMapper.toAlpha2('pk')).toBe('PK');
  });

  it('returns null for an invalid alpha-3', () => {
    expect(CountryCodeMapper.toAlpha2('ZZZ')).toBeNull();
  });

  it('returns null for an invalid alpha-2', () => {
    expect(CountryCodeMapper.toAlpha2('XX')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(CountryCodeMapper.toAlpha2('')).toBeNull();
  });

  it('returns null for a code that is neither 2 nor 3 letters', () => {
    expect(CountryCodeMapper.toAlpha2('INDIA')).toBeNull();
    expect(CountryCodeMapper.toAlpha2('I')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(CountryCodeMapper.toAlpha2('ind')).toBe('IN');
    expect(CountryCodeMapper.toAlpha2('Nld')).toBe('NL');
  });
});

describe('CountryCodeMapper.getFullMapping', () => {
  it('returns a non-empty object', () => {
    const mapping = CountryCodeMapper.getFullMapping();
    expect(typeof mapping).toBe('object');
    expect(Object.keys(mapping).length).toBeGreaterThan(0);
  });

  it('includes known aliases', () => {
    const mapping = CountryCodeMapper.getFullMapping();
    expect(mapping['USA']).toBe('US');
    expect(mapping['UK']).toBe('GB');
  });

  it('returns a copy (mutations do not affect internal state)', () => {
    const mapping = CountryCodeMapper.getFullMapping();
    mapping['FAKE'] = 'ZZ';
    const mapping2 = CountryCodeMapper.getFullMapping();
    expect(mapping2['FAKE']).toBeUndefined();
  });
});
