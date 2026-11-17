import {
  articleUrlKey,
  httpsVariant,
  isInsecureUrl,
  normalizeArticleUrl,
} from './normalize-article-url';

describe('normalizeArticleUrl', () => {
  it('forces https so an upgraded article keys the same as its original', () => {
    expect(normalizeArticleUrl('http://example.com/a')).toBe(
      'https://example.com/a',
    );
    expect(normalizeArticleUrl('http://example.com/a')).toBe(
      normalizeArticleUrl('https://example.com/a'),
    );
  });

  it('lowercases the host and drops a leading www.', () => {
    expect(normalizeArticleUrl('https://WWW.Example.COM/a')).toBe(
      'https://example.com/a',
    );
  });

  it('drops the default port', () => {
    expect(normalizeArticleUrl('https://example.com:443/a')).toBe(
      'https://example.com/a',
    );
  });

  it('drops the fragment', () => {
    expect(normalizeArticleUrl('https://example.com/a#section-2')).toBe(
      'https://example.com/a',
    );
  });

  it('drops credentials', () => {
    expect(normalizeArticleUrl('https://u:p@example.com/a')).toBe(
      'https://example.com/a',
    );
  });

  it('drops a trailing slash on a real path but keeps the root', () => {
    expect(normalizeArticleUrl('https://example.com/a/')).toBe(
      'https://example.com/a',
    );
    expect(normalizeArticleUrl('https://example.com/')).toBe(
      'https://example.com/',
    );
  });

  describe('tracking parameters', () => {
    it('drops every utm_* parameter', () => {
      expect(
        normalizeArticleUrl(
          'https://example.com/a?utm_source=mera.news&utm_medium=share&utm_campaign=x',
        ),
      ).toBe('https://example.com/a');
    });

    // The app appends utm_source/utm_medium when sharing, so a shared link must
    // normalize back to the article it came from.
    it('makes a shared link equal the original', () => {
      expect(
        normalizeArticleUrl(
          'https://example.com/a?utm_source=mera.news&utm_medium=share',
        ),
      ).toBe(normalizeArticleUrl('https://example.com/a'));
    });

    it.each(['fbclid', 'gclid', 'msclkid', 'igshid', 'mc_cid', 'twclid'])(
      'drops %s',
      (param) => {
        expect(normalizeArticleUrl(`https://example.com/a?${param}=xyz`)).toBe(
          'https://example.com/a',
        );
      },
    );

    it('matches tracking parameter names case-insensitively', () => {
      expect(normalizeArticleUrl('https://example.com/a?UTM_Source=x')).toBe(
        'https://example.com/a',
      );
    });

    // The failure this conservatism prevents: dropping a real identifier merges
    // two distinct articles into one cache entry.
    it('keeps parameters that carry article identity', () => {
      expect(normalizeArticleUrl('https://example.com/story?id=123')).toBe(
        'https://example.com/story?id=123',
      );
      expect(normalizeArticleUrl('https://example.com/p?ref=homepage')).toBe(
        'https://example.com/p?ref=homepage',
      );
    });

    it('keeps real parameters while dropping trackers alongside them', () => {
      expect(
        normalizeArticleUrl('https://example.com/p?id=7&utm_source=x&page=2'),
      ).toBe('https://example.com/p?id=7&page=2');
    });
  });

  describe('tolerated malformed input', () => {
    it('accepts a protocol-relative url', () => {
      expect(normalizeArticleUrl('//example.com/a')).toBe(
        'https://example.com/a',
      );
    });

    it('accepts a bare host/path', () => {
      expect(normalizeArticleUrl('example.com/a')).toBe(
        'https://example.com/a',
      );
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeArticleUrl('  https://example.com/a  ')).toBe(
        'https://example.com/a',
      );
    });

    // Never throw, never return empty for non-empty input — a caller storing
    // this into article_url must not be handed undefined.
    it.each([
      'mailto:editor@example.com',
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://example.com/a',
      'not a url at all',
    ])('returns %p unchanged rather than throwing', (input) => {
      expect(normalizeArticleUrl(input)).toBe(input);
    });

    // WHATWG promotes the first segment to the host for special schemes rather
    // than yielding an empty host — documented so the absent guard reads as
    // deliberate.
    it('promotes the first segment to the host on extra slashes', () => {
      expect(normalizeArticleUrl('///path')).toBe('https://path/');
    });

    it('returns an empty string for empty input', () => {
      expect(normalizeArticleUrl('')).toBe('');
      expect(normalizeArticleUrl('   ')).toBe('');
    });
  });

  it('is idempotent', () => {
    const once = normalizeArticleUrl(
      'HTTP://WWW.Example.com:80/a/?utm_source=x#frag',
    );
    expect(normalizeArticleUrl(once)).toBe(once);
  });
});

describe('articleUrlKey', () => {
  it('is insensitive to query parameter order', () => {
    expect(articleUrlKey('https://example.com/p?b=2&a=1')).toBe(
      articleUrlKey('https://example.com/p?a=1&b=2'),
    );
  });

  it('is insensitive to path casing', () => {
    expect(articleUrlKey('https://example.com/Article-One')).toBe(
      articleUrlKey('https://example.com/article-one'),
    );
  });

  it('collapses the http and https forms of one article', () => {
    expect(articleUrlKey('http://www.example.com/a/')).toBe(
      articleUrlKey('https://example.com/a'),
    );
  });

  it('still separates genuinely different articles', () => {
    expect(articleUrlKey('https://example.com/a')).not.toBe(
      articleUrlKey('https://example.com/b'),
    );
    expect(articleUrlKey('https://example.com/p?id=1')).not.toBe(
      articleUrlKey('https://example.com/p?id=2'),
    );
  });

  it('is idempotent', () => {
    const once = articleUrlKey('HTTP://WWW.Example.com/A?b=2&a=1#x');
    expect(articleUrlKey(once)).toBe(once);
  });

  it('falls back to a lowercased trim for unparseable input', () => {
    expect(articleUrlKey('  Not A URL  ')).toBe('not a url');
  });
});

describe('isInsecureUrl', () => {
  it('detects http', () => {
    expect(isInsecureUrl('http://example.com/a')).toBe(true);
    expect(isInsecureUrl('  HTTP://example.com/a')).toBe(true);
  });

  it('does not flag https', () => {
    expect(isInsecureUrl('https://example.com/a')).toBe(false);
  });

  // "https" starts with "http" — the check must not be a bare prefix test.
  it('does not flag https via a prefix mistake', () => {
    expect(isInsecureUrl('https://http.example.com/a')).toBe(false);
  });
});

describe('httpsVariant', () => {
  it('swaps only the scheme, leaving the rest byte-identical', () => {
    // Deliberately NOT normalized: the probe must request exactly what the
    // publisher published, or our own tidying produces a 404 that reads as
    // "https unavailable" and blocks a good article.
    expect(httpsVariant('http://WWW.Example.com/A/?utm_source=x')).toBe(
      'https://WWW.Example.com/A/?utm_source=x',
    );
  });

  it('returns null when there is nothing to upgrade', () => {
    expect(httpsVariant('https://example.com/a')).toBeNull();
    expect(httpsVariant('example.com/a')).toBeNull();
  });
});
