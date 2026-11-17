import { buildArticleData } from './article-data';

describe('buildArticleData (v1 parity)', () => {
  it('includes country + category when both present', () => {
    expect(buildArticleData('T', 'D', 'India', 'politics')).toBe(
      'News article from a publisher based out of India about politics. Title: T. Description: D.',
    );
  });

  it('country only', () => {
    expect(buildArticleData('T', 'D', 'India', null)).toBe(
      'News article from a publisher based out of India. Title: T. Description: D.',
    );
  });

  it('category only', () => {
    expect(buildArticleData('T', 'D', null, 'sports')).toBe(
      'News article about sports. Title: T. Description: D.',
    );
  });

  it('no metadata (the text-matching input)', () => {
    expect(buildArticleData('T', 'D', null, null)).toBe(
      'News article. Title: T. Description: D.',
    );
  });

  it("suppresses 'general_news' from the intro", () => {
    expect(buildArticleData('T', 'D', 'India', 'general_news')).toBe(
      'News article from a publisher based out of India. Title: T. Description: D.',
    );
    expect(buildArticleData('T', 'D', null, 'general_news')).toBe(
      'News article. Title: T. Description: D.',
    );
  });

  it('omits the Description clause when description is empty/absent', () => {
    expect(buildArticleData('T', '', null, null)).toBe(
      'News article. Title: T.',
    );
    expect(buildArticleData('T', undefined, null, null)).toBe(
      'News article. Title: T.',
    );
  });

  it('trims whitespace in country/category/description', () => {
    expect(buildArticleData('T', '  D  ', '  India  ', '  politics  ')).toBe(
      'News article from a publisher based out of India about politics. Title: T. Description: D.',
    );
  });
});
