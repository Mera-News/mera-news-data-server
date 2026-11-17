import { CRAWLER_USER_AGENT } from './crawler-identity';

/**
 * The string is pinned here rather than merely exported, because a third copy
 * lives outside this repo in the promo site's /bot page, inside a copy-paste
 * block offered for firewall and CDN rules. That copy cannot import this one,
 * so an exact-bytes assertion on each side is what makes drift a test failure
 * instead of a publisher complaint about traffic that does not match the rule
 * they were given.
 */
describe('CRAWLER_USER_AGENT', () => {
  it('is the exact frozen string, byte for byte', () => {
    expect(CRAWLER_USER_AGENT).toBe('MeraNewsBot/1.0 (+https://mera.news/bot)');
  });

  // Each of these has burned someone before: a trailing slash, a capitalised
  // path segment or a missing space all break an exact-match allowlist rule
  // while still looking right at a glance.
  it('keeps the details an allowlist rule matches on', () => {
    expect(CRAWLER_USER_AGENT).not.toMatch(/\/$/);
    expect(CRAWLER_USER_AGENT).toContain(' (+https://');
    expect(CRAWLER_USER_AGENT).toContain('mera.news/bot');
    expect(CRAWLER_USER_AGENT).not.toContain('/Bot');
  });

  it('does not claim to be a browser', () => {
    expect(CRAWLER_USER_AGENT).not.toContain('Mozilla');
    expect(CRAWLER_USER_AGENT).not.toContain('AppleWebKit');
  });

  // The whole point of the contact URL is that a publisher can reach us
  // instead of blocking us, so the string is useless without one.
  it('carries a contact URL', () => {
    expect(CRAWLER_USER_AGENT).toMatch(/\(\+https:\/\/\S+\)$/);
  });
});
