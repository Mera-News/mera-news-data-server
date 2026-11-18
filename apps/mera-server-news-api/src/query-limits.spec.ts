import { buildSchema, parse, validate } from 'graphql';
import { ADAPTER_DOCUMENTS } from './modules/adapter-documents';
import { CLIENT_DOCUMENTS } from './modules/client-documents';
import { ConfigService } from '@nestjs/config';
import { maxQueryDepth, queryLimitsRule } from './query-limits';

const schema = buildSchema('type Query { a: Int }');

const run = (document: string, maxDepth = 12, maxFields = 1000) =>
  validate(schema, parse(document), [queryLimitsRule(maxDepth, maxFields)]);

const nested = (levels: number) =>
  `{ ${'a { '.repeat(levels - 1)}a${' }'.repeat(levels - 1)} }`;

describe('query limits', () => {
  it('refuses a query 13 levels deep', () => {
    const errors = run(nested(13));
    expect(errors).toHaveLength(1);
    expect(errors[0].extensions.code).toBe('QUERY_TOO_COMPLEX');
    expect(errors[0].message).toContain('12');
  });

  it('accepts a query 12 levels deep', () => {
    expect(run(nested(12))).toEqual([]);
  });

  it('counts the depth of a fragment at its use site', () => {
    const doc = `
      query { a { ...F } }
      fragment F on T { a { a { a } } }`;
    expect(run(doc, 3)).toHaveLength(1);
    expect(run(doc, 4)).toEqual([]);
  });

  it('refuses more selections than the limit, fragments expanded', () => {
    const doc = `
      query { x: a { ...F } y: a { ...F } }
      fragment F on T { b c d }`;
    // 2 aliased roots + 2 x 3 fragment fields
    expect(run(doc, 12, 7)).toHaveLength(1);
    expect(run(doc, 12, 8)).toEqual([]);
  });

  it('accepts exactly 1000 root selections and refuses 1001', () => {
    const fields = (n: number) =>
      `{ ${Array.from({ length: n }, (_, i) => `f${i}: a`).join(' ')} }`;
    expect(run(fields(1000))).toEqual([]);
    expect(run(fields(1001))).toHaveLength(1);
  });

  it('does not loop on a fragment cycle', () => {
    const doc = `
      query { ...A }
      fragment A on T { a { ...B } }
      fragment B on T { a { ...A } }`;
    expect(() => run(doc)).not.toThrow();
  });

  it('does not count depth inside introspection', () => {
    const introspection = `{ __schema { types { fields { type { ${'ofType { '.repeat(14)}name${' }'.repeat(14)} } } } } }`;
    expect(run(introspection)).toEqual([]);
  });

  it('accepts every client and adapter document', () => {
    for (const document of [
      ...Object.values(CLIENT_DOCUMENTS),
      ...Object.values(ADAPTER_DOCUMENTS),
    ]) {
      expect(run(document).map((e) => e.message)).toEqual([]);
    }
  });
});

describe('NEWS_API_MAX_QUERY_DEPTH', () => {
  const config = (values: Record<string, string>) => new ConfigService(values);

  it('defaults to 12', () => {
    expect(maxQueryDepth(config({}))).toBe(12);
  });

  it('refuses a value that is not a positive whole number', () => {
    expect(() =>
      maxQueryDepth(config({ NEWS_API_MAX_QUERY_DEPTH: '0' })),
    ).toThrow('NEWS_API_MAX_QUERY_DEPTH');
  });
});
