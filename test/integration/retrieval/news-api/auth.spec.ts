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

describe('news API in open mode', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi({
      env: { MERA_NEWS_API_KEY: '', NEWS_API_OPEN: 'true' },
    });
  });
  afterAll(() => api.close());

  it('answers both app operations with no key', async () => {
    const persona = await api.gql(
      `{ articleIdsForPersona(query: { topics: [], limitPerTopic: 5 }) { topicResults { topicText } } }`,
      {},
      null,
    );
    const byIds = await api.gql(
      `{ articlesForTopicsByIds(articleIds: []) { dailyLimitReached } }`,
      {},
      null,
    );

    for (const res of [persona, byIds]) {
      expect(res.status).toBe(200);
      expect(res.body.errors).toBeUndefined();
    }
  });
});

describe('news API with NEWS_API_OPEN set to something else', () => {
  it('fails to boot, naming the allowed values', async () => {
    await expect(bootNewsApi({ env: { NEWS_API_OPEN: '1' } })).rejects.toThrow(
      'true or false',
    );
  });
});

describe('news API open mode rate limit', () => {
  let api: NewsApi;

  beforeAll(async () => {
    api = await bootNewsApi({
      env: {
        MERA_NEWS_API_KEY: '',
        NEWS_API_OPEN: 'true',
        NEWS_API_OPEN_RATE_LIMIT: '3',
      },
    });
  });
  afterAll(() => api.close());

  it('refuses the 4th request in a minute and keeps /health open', async () => {
    const results = [];
    for (let i = 0; i < 3; i++)
      results.push(await api.gql(COUNTRIES, {}, null));
    expect(results.map((r) => r.body.errors)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);

    const refused = await api
      .http()
      .post('/graphql')
      .send({ query: COUNTRIES, variables: {} });
    // GraphQL keeps HTTP 200 for an error inside execution; the code and the
    // header carry the refusal.
    expect(refused.status).toBe(200);
    expect(refused.headers['retry-after']).toMatch(/^[0-9]+$/);
    const body = refused.body as {
      errors?: { extensions?: { code?: string } }[];
    };
    expect(body.errors?.[0].extensions?.code).toBe('TOO_MANY_REQUESTS');
    await api.http().get('/health').expect(200);
  });

  it('rejects a limit that is not a positive whole number', async () => {
    await expect(
      bootNewsApi({
        env: { NEWS_API_OPEN: 'true', NEWS_API_OPEN_RATE_LIMIT: 'lots' },
      }),
    ).rejects.toThrow('NEWS_API_OPEN_RATE_LIMIT');
  });
});
