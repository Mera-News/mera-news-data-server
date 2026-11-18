import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * The canonical topics API is APP-ONLY. The internal news-api (which
 * news clients consume) builds its schema from `libs/mera-news-core`, so a
 * `@Field`, enum or arg added there instead of in apps/mera-server-graphql
 * would silently widen this relay's contract.
 *
 * Two checks, because the schema file below only regenerates when news-api
 * boots: the checked-in schema text, and the SOURCE that would produce it.
 */
const APP_ONLY = ['CanonicalTopic', 'canonicalTopics'];

// Whole names only: the shared facet type `CanonicalTopicFacet` is public.
const whole = (name: string) => new RegExp(`\\b${name}\\b`);

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('news-api stays free of app-only publication-page API', () => {
  it('its checked-in schema.gql has none of the app-only names', () => {
    const schema = readFileSync(join(__dirname, 'schema.gql'), 'utf8');
    expect(schema).toContain('articlesForPublisher(');
    for (const name of APP_ONLY) expect(schema).not.toMatch(whole(name));
  });

  it('neither news-core nor news-api source declares them', () => {
    const roots = [
      join(__dirname, '..', '..', '..', 'libs', 'mera-news-core', 'src'),
      __dirname,
    ];
    const offenders = roots.flatMap(tsFiles).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return APP_ONLY.some((name) => whole(name).test(text));
    });
    expect(offenders).toEqual([]);
  });
});
