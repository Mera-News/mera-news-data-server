import {
  ADDRESS_WITHHELD,
  redactAddress,
  scrubUrlsInText,
  stripUrlSecrets,
} from './strip-url-secrets';

describe('stripUrlSecrets', () => {
  it('keeps origin and path only', () => {
    expect(
      stripUrlSecrets('https://u:p@feeds.example.test/rss?token=a#frag'),
    ).toBe('https://feeds.example.test/rss');
  });

  it('leaves an address with no query and no userinfo as it is', () => {
    expect(stripUrlSecrets('https://feeds.example.test/rss.xml')).toBe(
      'https://feeds.example.test/rss.xml',
    );
  });

  it('answers an empty string for malformed and non-web values, never throwing', () => {
    for (const bad of ['', 'not a url', '::::', 'data:text/plain,x']) {
      expect(stripUrlSecrets(bad)).toBe('');
    }
  });
});

describe('redactAddress', () => {
  it('never returns the raw text of a value it cannot parse', () => {
    for (const bad of ['not a url ?key=zq7', 'data:text/plain,zq7']) {
      expect(redactAddress(bad)).toBe(ADDRESS_WITHHELD);
    }
  });
});

describe('scrubUrlsInText', () => {
  it('redacts every address in an error message', () => {
    const message =
      'request to https://u:p@feeds.example.test/rss?key=zq7 failed, redirected from http://a.example.test/x?token=zq7';
    const scrubbed = scrubUrlsInText(message);
    expect(scrubbed).not.toContain('zq7');
    expect(scrubbed).not.toContain('u:p@');
    expect(scrubbed).toBe(
      'request to https://feeds.example.test/rss failed, redirected from http://a.example.test/x',
    );
  });

  it('leaves text without an address unchanged', () => {
    expect(scrubUrlsInText('timeout of 30000ms exceeded')).toBe(
      'timeout of 30000ms exceeded',
    );
  });
});
