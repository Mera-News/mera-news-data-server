import { bootNewsApi, type NewsApi } from '../support/boot-news-api';

const COUNTRIES = '{ allCountries }';

describe('news API authentication', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi();
  });
  afterAll(() => api.close());

  it('refuses a missing key and a wrong key with the same message', async () => {
    const missing = await api.gql(COUNTRIES, {}, null);
    const wrong = await api.gql(COUNTRIES, {}, 'not-the-key');

    for (const res of [missing, wrong]) {
      expect(res.body.errors?.[0].message).toBe('Invalid API key');
      expect(res.body.data ?? null).toBeNull();
    }
  });

  it('answers 200 with the right key', async () => {
    const res = await api.gql<{ allCountries: string[] }>(COUNTRIES);

    expect(res.status).toBe(200);
    expect(res.body.errors).toBeUndefined();
    expect(Array.isArray(res.body.data?.allCountries)).toBe(true);
  });

  it('serves /health without a key', async () => {
    await api.http().get('/health').expect(200);
  });
});

describe('news API with no key configured', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi({ env: { MERA_NEWS_API_KEY: '' } });
  });
  afterAll(() => api.close());

  it('refuses every operation, whatever key is sent', async () => {
    for (const key of [null, '', 'news-api-test-key']) {
      const res = await api.gql(COUNTRIES, {}, key);
      expect(res.body.errors?.[0].message).toBe(
        'MERA_NEWS_API_KEY is not configured',
      );
      expect(res.body.data ?? null).toBeNull();
    }
  });
});
