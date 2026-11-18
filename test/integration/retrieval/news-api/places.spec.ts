import mongoose from 'mongoose';
import { CLIENT_DOCUMENTS } from '../../../../apps/mera-server-news-api/src/modules/client-documents';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';

interface PlaceRow {
  city: string;
  displayName: string;
  population: number | null;
}

const place = (city: string, population: number, key = city.toLowerCase()) => ({
  city,
  countryCode: 'XX',
  displayName: `${city}, XX`,
  normalized: key,
  search_keys: [key],
  population,
});

describe('place search on the news API', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());
  beforeEach(() => api.resetDb());

  const search = (variables: Record<string, unknown>) =>
    api.gql<{ placeSearch: PlaceRow[] }>(
      CLIENT_DOCUMENTS.PlaceSearch,
      variables,
    );
  const seed = (rows: object[]) =>
    api.connection.collection('places').insertMany(rows);

  it('answers a prefix match, most populated first', async () => {
    await seed([
      place('Testford', 200_000),
      place('Testville', 500_000),
      place('Sampleton', 900_000),
    ]);
    const res = await search({ query: 'Test' });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.placeSearch.map((p) => p.city)).toEqual([
      'Testville',
      'Testford',
    ]);
  });

  it('matches only from the start of a key', async () => {
    await seed([place('Testville', 1)]);
    const res = await search({ query: 'ville' });
    expect(res.body.data!.placeSearch).toEqual([]);
  });

  it('answers [] for one character', async () => {
    await seed([place('Testville', 1)]);
    const res = await search({ query: 'T' });
    expect(res.body.data!.placeSearch).toEqual([]);
  });

  it('clamps limit to 15 and defaults to 8', async () => {
    await seed(Array.from({ length: 20 }, (_, i) => place(`Testburg${i}`, i)));
    const big = await search({ query: 'test', limit: 100 });
    const none = await search({ query: 'test', limit: 0 });
    const dflt = await search({ query: 'test' });

    expect(big.body.data!.placeSearch).toHaveLength(15);
    expect(none.body.data!.placeSearch).toHaveLength(1);
    expect(dflt.body.data!.placeSearch).toHaveLength(8);
  });

  it('refuses a 65-character query, names the limit and does not echo it', async () => {
    const query = 'qz'.repeat(32) + 'x';
    const res = await search({ query });

    expect(res.body.errors?.[0].message).toMatch(/64/);
    expect(JSON.stringify(res.body).includes('qzqz')).toBe(false);
  });

  it('accepts a 64-character query', async () => {
    const res = await search({ query: 'a'.repeat(64) });
    expect(res.body.errors).toBeUndefined();
  });

  it('matches a hostile pattern as plain text, fast', async () => {
    await seed([place('aaaa', 1)]);
    const started = Date.now();
    const res = await search({ query: `(a+)+$${'a'.repeat(30)}!` });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.body.data!.placeSearch).toEqual([]);
  });

  it('bounds the scan with maxTimeMS 1000', async () => {
    const seen: unknown[] = [];
    mongoose.set(
      'debug',
      (collection: string, method: string, ...rest: unknown[]) => {
        if (collection === 'places' && method === 'find')
          seen.push(rest[rest.length - 1]);
      },
    );
    try {
      await search({ query: 'test' });
    } finally {
      mongoose.set('debug', false);
    }
    expect(
      seen.some((o) => (o as { maxTimeMS?: number })?.maxTimeMS === 1000),
    ).toBe(true);
  });

  it('answers [] on an unseeded server', async () => {
    const res = await search({ query: 'test' });
    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.placeSearch).toEqual([]);
  });

  it('refuses a missing key like every other operation', async () => {
    const res = await api.gql(
      CLIENT_DOCUMENTS.PlaceSearch,
      { query: 'test' },
      null,
    );
    expect(res.body.errors?.[0].message).toBe('Invalid API key');
  });
});
