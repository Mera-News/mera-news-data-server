import fs from 'fs';
import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';

const MARKER = 'zq7marker41';
// Shaped like an id, so it passes the filter's own check.
const HEX_MARKER = 'abcdef0123456789abcdef01';

/**
 * Everything the Nest logger, stdout, stderr and writes straight to descriptors 1 and 2 receive
 * until `restore()`. The request logger writes to the descriptor, not through `process.stdout`.
 */
function captureLogs() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(
      args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' '),
    );
  };
  Logger.overrideLogger({
    log: push,
    error: push,
    warn: push,
    debug: push,
    verbose: push,
    fatal: push,
  });
  const out = jest.spyOn(process.stdout, 'write').mockImplementation((c) => {
    push(String(c));
    return true;
  });
  const err = jest.spyOn(process.stderr, 'write').mockImplementation((c) => {
    push(String(c));
    return true;
  });
  const realWriteSync = fs.writeSync;
  const fdWrite = jest.spyOn(fs, 'writeSync').mockImplementation(((
    fd: number,
    chunk: unknown,
    ...rest: unknown[]
  ) => {
    if (fd !== 1 && fd !== 2) {
      return (realWriteSync as (...a: unknown[]) => number)(fd, chunk, ...rest);
    }
    push(String(chunk));
    return Buffer.byteLength(String(chunk));
  }) as typeof fs.writeSync);
  const realWrite = fs.write;
  const fdWriteAsync = jest.spyOn(fs, 'write').mockImplementation(((
    fd: number,
    ...rest: unknown[]
  ) => {
    if (fd !== 1 && fd !== 2) {
      return (realWrite as (...a: unknown[]) => void)(fd, ...rest);
    }
    push(String(rest[0]));
    const done = rest[rest.length - 1];
    if (typeof done === 'function') {
      (done as (e: null, n: number) => void)(
        null,
        Buffer.byteLength(String(rest[0])),
      );
    }
  }) as unknown as typeof fs.write);
  return {
    lines,
    restore() {
      fdWriteAsync.mockRestore();
      out.mockRestore();
      err.mockRestore();
      fdWrite.mockRestore();
      Logger.overrideLogger(false);
    },
  };
}

describe('request text in the news API logs', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi({ env: { LOG_LEVEL: 'info' } });
  });
  afterAll(() => api.close());

  it('logs no request text for a valid request, a validation failure, a throwing resolver or a GET', async () => {
    const capture = captureLogs();
    try {
      await api.gql(
        'query($q: String!) { searchPublishers(query: $q) { publishers { _id } } }',
        { q: MARKER },
      );
      await api.gql(
        'query($ids: [ID!]!) { articlesForStories(articleIds: $ids) { articles { _id } } }',
        { ids: MARKER },
      );
      await api.gql(
        'query($q: String!) { searchPublishers(query: $q) { publishers { _id } } }',
        { q: MARKER.repeat(6) },
      );
      await api
        .http()
        .get('/graphql')
        .query({
          query: `{ searchPublishers(query: "${MARKER}") { publishers { _id } } }`,
          variables: JSON.stringify({ q: MARKER }),
        })
        .set('x-api-key', 'news-api-test-key');
      // The logger writes after the response is sent.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      capture.restore();
    }

    // Positive control: the capture sees the request log lines.
    expect(
      capture.lines.filter((l) => l.includes('"/graphql')).length,
    ).toBeGreaterThanOrEqual(4);
    expect(capture.lines.filter((l) => l.includes(MARKER))).toEqual([]);
  });

  it('logs no place query text for a valid request, a too long one or a wrong type', async () => {
    const capture = captureLogs();
    const doc = 'query($q: String!) { placeSearch(query: $q) { _id } }';
    try {
      const valid = await api.gql<{ placeSearch: unknown[] }>(doc, {
        q: MARKER,
      });
      // The resolver ran: a valid query answers data, not a validation error.
      expect(valid.body.errors).toBeUndefined();
      expect(valid.body.data?.placeSearch).toEqual([]);
      await api.gql(doc, { q: MARKER.repeat(6) });
      await api.gql(doc, { q: { text: MARKER } });
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      capture.restore();
    }

    expect(
      capture.lines.filter((l) => l.includes('"/graphql')).length,
    ).toBeGreaterThanOrEqual(3);
    expect(capture.lines.filter((l) => l.includes(MARKER))).toEqual([]);
  });

  it('logs no reader preference text for a valid related request, a too long one or a wrong type', async () => {
    const capture = captureLogs();
    const doc =
      'query($id: ID!, $c: RelatedArticlesContextInput) { relatedArticlesPage(articleId: $id, context: $c) { articles { _id } } }';
    const id = String(new Types.ObjectId());
    try {
      const valid = await api.gql<{
        relatedArticlesPage: { articles: unknown[] };
      }>(doc, {
        id,
        c: { subscribedPublications: [MARKER], appLanguageBase: MARKER },
      });
      // The resolver ran: a valid request answers a page, not a validation error.
      expect(valid.body.errors).toBeUndefined();
      expect(valid.body.data?.relatedArticlesPage.articles).toEqual([]);
      const long = await api.gql(doc, {
        id,
        c: { subscribedPublications: [MARKER.repeat(6)] },
      });
      expect(long.body.errors?.[0].message).toMatch(/64/);
      await api.gql(doc, {
        id,
        c: { subscribedPublications: { text: MARKER } },
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      capture.restore();
    }

    expect(
      capture.lines.filter((l) => l.includes('"/graphql')).length,
    ).toBeGreaterThanOrEqual(3);
    expect(capture.lines.filter((l) => l.includes(MARKER))).toEqual([]);
  });

  it('logs no publication name for a valid profile request, a too long one or a wrong type', async () => {
    const capture = captureLogs();
    const doc =
      'query($n: String, $cc: String) { publicationProfile(name: $n, countryCode: $cc) { newsPublisherId } }';
    try {
      const valid = await api.gql<{ publicationProfile: unknown }>(doc, {
        n: MARKER,
        cc: 'NLD',
      });
      // The resolver ran: an unknown name answers null, not an error.
      expect(valid.body.errors).toBeUndefined();
      expect(valid.body.data).toEqual({ publicationProfile: null });
      const long = await api.gql(doc, { n: MARKER.repeat(19), cc: 'NLD' });
      expect(long.body.errors?.[0].message).toMatch(/200/);
      await api.gql(doc, { n: { text: MARKER }, cc: 'NLD' });
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      capture.restore();
    }

    expect(
      capture.lines.filter((l) => l.includes('"/graphql')).length,
    ).toBeGreaterThanOrEqual(3);
    expect(capture.lines.filter((l) => l.includes(MARKER))).toEqual([]);
  });

  it('logs no topic filter value for a valid world headlines request, a refused one or a wrong type', async () => {
    const capture = captureLogs();
    const doc =
      'query($ids: [ID!], $after: String) { worldHeadlines(countryCode: "ZZZ", canonicalTopicIds: $ids, after: $after) { unavailableReason headlines { stableClusterId } } }';
    try {
      const valid = await api.gql<{
        worldHeadlines: { unavailableReason: string | null };
      }>(doc, { ids: [HEX_MARKER] });
      // The resolver ran: a filter with no edition answers a reason, not a validation error.
      expect(valid.body.errors).toBeUndefined();
      expect(valid.body.data?.worldHeadlines.unavailableReason).toBe(
        'NO_EDITION',
      );
      const invalid = await api.gql(doc, { ids: [MARKER] });
      expect(invalid.body.errors?.[0].message).toMatch(/24/);
      await api.gql(doc, { ids: [HEX_MARKER], after: MARKER });
      await api.gql(doc, { ids: { text: MARKER } });
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      capture.restore();
    }

    expect(
      capture.lines.filter((l) => l.includes('"/graphql')).length,
    ).toBeGreaterThanOrEqual(4);
    expect(capture.lines.filter((l) => l.includes(MARKER))).toEqual([]);
    expect(capture.lines.filter((l) => l.includes(HEX_MARKER))).toEqual([]);
  });
});
