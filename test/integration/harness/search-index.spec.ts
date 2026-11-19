import { Logger } from '@nestjs/common';
import request from 'supertest';
import {
  NEWS_ARTICLE_COLLECTION,
  retrievalIndexDefinition,
  textIndexDefinition,
  VECTOR_INDEX_NAME,
} from '@mera/models/search-index/retrieval-index';
import { SEARCH_INDEX_STATE } from '@mera/shared/health/search-index-state';
import type { SearchIndexState } from '@mera/shared/health/search-index-state';
import {
  InMemorySearchIndexAdmin,
  searchIndexError,
} from '../../harness/atlas-search-fake';
import { bootAsyncApp, type Harness } from '../../harness/boot';
import { bootNewsApi, type NewsApi } from '../retrieval/support/boot-news-api';

const VECTOR = retrievalIndexDefinition(768);
const TEXT = textIndexDefinition();

const STATUS = `{ newsServerStatus { vectorIndexState textIndexState embeddingModel } }`;

interface Status {
  vectorIndexState: string | null;
  textIndexState: string | null;
  embeddingModel: string | null;
}

/** Runs `body` with these env values set, then puts the old ones back. */
async function withEnv<T>(
  env: Record<string, string>,
  body: () => Promise<T>,
): Promise<T> {
  const saved = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('search indexes at boot', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let clock: jest.SpyInstance | undefined;
  const open: { close(): Promise<void> }[] = [];

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });
  afterEach(async () => {
    clock?.mockRestore();
    clock = undefined;
    warn.mockRestore();
    error.mockRestore();
    await Promise.all(open.splice(0).map((app) => app.close()));
  });

  const async_ = async (
    admin: InMemorySearchIndexAdmin,
    env: Record<string, string> = {},
  ): Promise<Harness> => {
    const harness = await withEnv(env, () =>
      bootAsyncApp({ searchIndexAdmin: admin }),
    );
    open.push(harness);
    return harness;
  };
  const newsApi = async (
    admin: InMemorySearchIndexAdmin,
    env: Record<string, string> = {},
  ): Promise<NewsApi> => {
    const api = await bootNewsApi({ searchIndexAdmin: admin, env });
    open.push(api);
    return api;
  };
  const status = async (api: NewsApi) => {
    const res = await api.gql<{ newsServerStatus: Status }>(STATUS);
    expect(res.body.errors).toBeUndefined();
    return res.body.data!.newsServerStatus;
  };
  const warnedAbout = (name: string) =>
    warn.mock.calls.filter(([line]) => String(line).includes(name));
  /** Moves the cache's clock past its 30 seconds. */
  const afterCacheExpiry = () => {
    const now = Date.now();
    clock?.mockRestore();
    clock = jest.spyOn(Date, 'now').mockReturnValue(now + 31_000);
  };

  it('creates the collection and both indexes in the async worker, not in the news API', async () => {
    const news = new InMemorySearchIndexAdmin();
    await newsApi(news);
    expect(news.createCalls).toEqual([]);
    expect(news.collections.size).toBe(0);

    const admin = new InMemorySearchIndexAdmin();
    await async_(admin);

    expect(admin.collections).toEqual(new Set([NEWS_ARTICLE_COLLECTION]));
    expect([...admin.indexes.keys()].sort()).toEqual(
      [VECTOR_INDEX_NAME, TEXT.name].sort(),
    );
    expect(admin.indexes.get(VECTOR_INDEX_NAME)).toMatchObject({
      type: 'vectorSearch',
      latestDefinition: VECTOR.definition,
    });
    expect(admin.indexes.get(TEXT.name)).toMatchObject({
      type: 'search',
      latestDefinition: TEXT.definition,
    });
  });

  it('creates when SEARCH_INDEX_CREATE is empty, which reads as unset', async () => {
    const admin = new InMemorySearchIndexAdmin();
    await async_(admin, { SEARCH_INDEX_CREATE: '' });
    expect(admin.createCalls).toHaveLength(2);
  });

  it('answers ready right after a create, not the missing it read before', async () => {
    const admin = new InMemorySearchIndexAdmin();
    const { app } = await async_(admin);
    const state = app.get<SearchIndexState>(SEARCH_INDEX_STATE, {
      strict: false,
    });
    expect(await state.vector()).toBe('ready');
    expect(await state.text()).toBe('ready');
  });

  it('counts "collection exists" (48) and "index exists" (68) as success', async () => {
    const admin = new InMemorySearchIndexAdmin();
    admin.collections.add(NEWS_ARTICLE_COLLECTION);
    admin.createLosesRace = true;

    const { app } = await async_(admin);

    expect(error).not.toHaveBeenCalled();
    const state = app.get<SearchIndexState>(SEARCH_INDEX_STATE, {
      strict: false,
    });
    expect(await state.vector()).toBe('ready');
  });

  it('logs any other create error, privilege included, and keeps booting', async () => {
    const admin = new InMemorySearchIndexAdmin();
    admin.createError = searchIndexError('not authorized', 13);

    const { app } = await async_(admin);

    expect(admin.createCalls).toEqual([VECTOR_INDEX_NAME, TEXT.name]);
    expect(error).toHaveBeenCalledTimes(2);
    const state = app.get<SearchIndexState>(SEARCH_INDEX_STATE, {
      strict: false,
    });
    expect(await state.vector()).toBe('missing');
  });

  it('builds nothing when the list cannot be read, even with creation on', async () => {
    const admin = new InMemorySearchIndexAdmin();
    admin.listError = searchIndexError('not authorized', 13);

    const { app } = await async_(admin);

    expect(admin.createCalls).toEqual([]);
    expect(admin.collections.size).toBe(0);
    const state = app.get<SearchIndexState>(SEARCH_INDEX_STATE, {
      strict: false,
    });
    expect(await state.vector()).toBe('unreadable');
  });

  describe('with SEARCH_INDEX_CREATE=false', () => {
    const OFF = { SEARCH_INDEX_CREATE: 'false' };

    it('creates nothing, reports missing, keeps readiness up and warns once per index', async () => {
      const admin = new InMemorySearchIndexAdmin();
      const { app } = await async_(admin, OFF);
      const api = await newsApi(admin, OFF);

      expect(admin.createCalls).toEqual([]);
      expect(admin.collections.size).toBe(0);
      const ready = await request(app.getHttpServer()).get('/health/ready');
      expect(ready.status).toBe(200);
      expect(await status(api)).toMatchObject({
        vectorIndexState: 'missing',
        textIndexState: 'missing',
      });
      // One line from each process that booted, for each missing index.
      expect(warnedAbout(VECTOR_INDEX_NAME)).toHaveLength(2);
      expect(warnedAbout(TEXT.name)).toHaveLength(2);
    });

    it('says to create it by hand and never to restart the worker', async () => {
      const admin = new InMemorySearchIndexAdmin();
      const api = await newsApi(admin, OFF);

      const res = await api.http().get('/health/ready');

      expect(res.status).toBe(200);
      const { vectorIndex, textIndex } = res.body.info;
      for (const index of [vectorIndex, textIndex]) {
        expect(index.state).toBe('missing');
        expect(index.detail).toMatch(/by hand/);
        expect(index.detail).not.toMatch(/restart|boot/i);
      }
      for (const [line] of warn.mock.calls) {
        expect(String(line)).not.toMatch(/restart/i);
      }
    });
  });

  it('says the worker creates a missing index at its next boot when creation is on', async () => {
    const api = await newsApi(new InMemorySearchIndexAdmin());

    const res = await api.http().get('/health/ready');

    expect(res.body.info.vectorIndex.detail).toMatch(/next boot/);
    expect(warnedAbout(VECTOR_INDEX_NAME)).toHaveLength(0);
  });

  it('turns building into ready once the 30 second cache expires', async () => {
    const admin = new InMemorySearchIndexAdmin();
    admin.createdStatus = { status: 'PENDING', queryable: false };
    await async_(admin);
    const api = await newsApi(admin);
    expect((await status(api)).vectorIndexState).toBe('building');

    admin.setStatus(VECTOR_INDEX_NAME, 'READY', true);
    admin.setStatus(TEXT.name, 'READY', true);
    expect((await status(api)).vectorIndexState).toBe('building');

    afterCacheExpiry();
    expect(await status(api)).toMatchObject({
      vectorIndexState: 'ready',
      textIndexState: 'ready',
    });
  });

  it('reports a size change found while running and does not throw', async () => {
    const admin = new InMemorySearchIndexAdmin();
    await async_(admin);
    const api = await newsApi(admin);
    const [vectorField, filter] = VECTOR.definition.fields;
    admin.plant({
      ...admin.indexes.get(VECTOR_INDEX_NAME)!,
      latestDefinition: {
        fields: [{ ...vectorField, numDimensions: 1024 }, filter],
      },
    });

    afterCacheExpiry();
    expect((await status(api)).vectorIndexState).toBe('dims_mismatch');
    const res = await api.http().get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.info.vectorIndex.detail).toMatch(/1024.*768/);
  });

  it('answers /health/ready with 200 and a state and detail for every state', async () => {
    const [vectorField, filter] = VECTOR.definition.fields;
    const planted = (
      status: string,
      queryable: boolean,
      fields: unknown[] = VECTOR.definition.fields,
    ) => ({
      name: VECTOR_INDEX_NAME,
      type: 'vectorSearch',
      status,
      queryable,
      latestDefinition: { fields } as never,
    });
    const cases: [string, (admin: InMemorySearchIndexAdmin) => void][] = [
      ['missing', () => undefined],
      ['building', (a) => a.plant(planted('BUILDING', false))],
      ['failed', (a) => a.plant(planted('FAILED', false))],
      ['ready', (a) => a.plant(planted('READY', true))],
      ['outdated', (a) => a.plant(planted('READY', true, [vectorField]))],
      [
        'dims_mismatch',
        (a) =>
          a.plant(
            planted('READY', true, [
              { ...vectorField, numDimensions: 1024 },
              filter,
            ]),
          ),
      ],
      [
        'unreadable',
        (a) => {
          a.listError = new Error('not authorized');
        },
      ],
    ];
    // Booted empty: a size change is refused at boot, so every state is
    // planted after it and read once the cache has expired.
    const admin = new InMemorySearchIndexAdmin();
    const api = await newsApi(admin);

    for (const [state, arrange] of cases) {
      admin.indexes.clear();
      admin.listError = undefined;
      arrange(admin);
      afterCacheExpiry();

      const res = await api.http().get('/health/ready');

      expect(res.status).toBe(200);
      expect(res.body.info.vectorIndex).toEqual({
        status: 'up',
        state,
        detail: expect.any(String),
      });
      expect(res.body.info.textIndex).toEqual({
        status: 'up',
        state: expect.any(String),
        detail: expect.any(String),
      });
    }
  });

  it('puts the states and the stored model in the status answer', async () => {
    const admin = new InMemorySearchIndexAdmin();
    await async_(admin);
    const api = await newsApi(admin);
    // The worker recorded the model its vectors are made with.
    const meta = api.connection.db!.collection('deployment-meta');
    await meta.updateOne(
      { _id: 'embedding' as never },
      { $set: { model: 'a-model' } },
    );

    try {
      expect(await status(api)).toEqual({
        vectorIndexState: 'ready',
        textIndexState: 'ready',
        embeddingModel: 'a-model',
      });
    } finally {
      // The database is shared with every later suite on this worker, which
      // would refuse to boot over another recorded model.
      await meta.deleteOne({ _id: 'embedding' as never });
    }
  });
});
