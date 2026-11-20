import { Logger } from '@nestjs/common';
import { SEARCH_INDEX_STATE } from '../../../../libs/mera-shared/src/health/search-index-state';
import {
  retrievalIndexDefinition,
  textIndexDefinition,
} from '../../../../libs/mera-models/src/search-index/retrieval-index';
import {
  installAtlasSearchFake,
  InMemorySearchIndexAdmin,
} from '../../../harness/atlas-search-fake';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';

type GqlError = { message: string; extensions?: Record<string, unknown> };

const VECTOR = retrievalIndexDefinition(768);
const TEXT = textIndexDefinition();

const COLD_TOPIC =
  'query($t: String!) { articleIdsForPersona(query: { topics: [{ text: $t }], limitPerTopic: 5 }) { topicResults { topicText } } }';
const SEARCH = 'query($q: String!) { searchNews(query: $q, limit: 5) { _id } }';

describe('answers while a search index is not ready', () => {
  const admin = new InMemorySearchIndexAdmin();
  let api: NewsApi;
  let lines: string[];
  // The state is read through a 30 s cache, so each test moves the clock past it.
  let offset = 0;
  const realNow = Date.now.bind(Date);
  let n = 0;
  const topic = () => `index state topic ${++n}`;

  const plant = (vector: string | null, text: string | null) => {
    admin.indexes.clear();
    if (vector) {
      admin.plant({
        name: VECTOR.name,
        type: VECTOR.type,
        latestDefinition: VECTOR.definition,
        status: vector,
        queryable: vector === 'READY',
      });
    }
    if (text) {
      admin.plant({
        name: TEXT.name,
        type: TEXT.type,
        latestDefinition: TEXT.definition,
        status: text,
        queryable: text === 'READY',
      });
    }
    offset += 31_000;
  };

  beforeAll(async () => {
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    plant('READY', 'READY');
    api = await bootNewsApi({ searchIndexAdmin: admin });
  });
  afterAll(async () => {
    await api.close();
    jest.restoreAllMocks();
  });
  beforeEach(() => {
    admin.listError = undefined;
    lines = [];
    const push = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    Logger.overrideLogger({
      log: push,
      error: push,
      warn: push,
      debug: push,
      verbose: push,
      fatal: push,
    });
  });
  afterEach(() => Logger.overrideLogger(false));

  const cold = () =>
    api.gql<unknown>(COLD_TOPIC, { t: topic() }).then((r) => r.body);
  const search = () =>
    api.gql<unknown>(SEARCH, { q: 'electric buses' }).then((r) => r.body);
  const codeOf = (body: { errors?: GqlError[] }) =>
    body.errors?.[0]?.extensions;

  describe('a cold topic', () => {
    it.each([
      ['missing', null],
      ['building', 'BUILDING'],
      ['failed', 'FAILED'],
    ])(
      'answers INDEX_NOT_READY with the state while the vector index is %s',
      async (state, status) => {
        plant(status, 'READY');
        expect(codeOf(await cold())).toMatchObject({
          code: 'INDEX_NOT_READY',
          state,
        });
      },
    );

    it('answers INDEX_NOT_READY while the vector index lacks a field', async () => {
      plant('READY', 'READY');
      admin.indexes.set(VECTOR.name, {
        ...admin.indexes.get(VECTOR.name)!,
        latestDefinition: { fields: [VECTOR.definition.fields[0]] },
      });
      expect(codeOf(await cold())).toMatchObject({
        code: 'INDEX_NOT_READY',
        state: 'outdated',
      });
    });

    it('answers INDEX_NOT_READY when the vector size changed after boot', async () => {
      plant('READY', 'READY');
      admin.indexes.set(VECTOR.name, {
        ...admin.indexes.get(VECTOR.name)!,
        latestDefinition: retrievalIndexDefinition(1024).definition,
      });
      expect(codeOf(await cold())).toMatchObject({
        code: 'INDEX_NOT_READY',
        state: 'dims_mismatch',
      });
    });

    it('answers as today when the list of indexes cannot be read', async () => {
      plant('READY', 'READY');
      admin.listError = new Error('not authorized');
      expect((await cold()).errors).toBeUndefined();
    });

    it('answers as today when the index is ready', async () => {
      plant('READY', 'READY');
      expect((await cold()).errors).toBeUndefined();
    });
  });

  describe('the log line', () => {
    let entries: { level: string; args: unknown[] }[];
    beforeEach(() => {
      entries = [];
      const at =
        (level: string) =>
        (...args: unknown[]) =>
          entries.push({ level, args });
      Logger.overrideLogger({
        log: at('log'),
        error: at('error'),
        warn: at('warn'),
        debug: at('debug'),
        verbose: at('verbose'),
        fatal: at('fatal'),
      });
    });
    const text = (args: unknown[]) =>
      args
        .map((a) =>
          a instanceof Error ? `${a.message}\n${a.stack}` : String(a),
        )
        .join(' ');

    it('is one warning without a stack for each not-ready answer', async () => {
      plant(null, 'READY');
      await cold();
      await cold();

      const notReady = entries.filter((e) =>
        text(e.args).includes('not ready'),
      );
      expect(notReady.map((e) => e.level)).toEqual(['warn', 'warn']);
      for (const e of notReady) expect(text(e.args)).not.toMatch(/\n\s+at /);
      expect(entries.filter((e) => e.level === 'error')).toEqual([]);
    });
  });

  describe('search', () => {
    // So the semantic leg answers; the fake refuses `$search`, so a lexical leg
    // that runs fails and is logged as failed, which tells "ran" from "skipped".
    let fake: ReturnType<typeof installAtlasSearchFake>;
    beforeAll(() => {
      fake = installAtlasSearchFake();
    });
    afterAll(() => fake.uninstall());

    const lexicalSkipped = () =>
      lines.some((l) => l.includes('lexical leg skipped'));

    it.each([
      ['missing', null],
      ['building', 'BUILDING'],
      ['failed', 'FAILED'],
    ])(
      'skips the lexical leg while the text index is %s',
      async (state, status) => {
        plant('READY', status);
        const body = await search();
        expect(body.errors).toBeUndefined();
        expect(lexicalSkipped()).toBe(true);
        expect(lines.some((l) => l.includes(state))).toBe(true);
      },
    );

    it('runs the lexical leg as today when the list cannot be read', async () => {
      plant('READY', 'READY');
      admin.listError = new Error('not authorized');
      await search();
      expect(lexicalSkipped()).toBe(false);
    });

    it('runs the lexical leg when the text index is ready', async () => {
      plant('READY', 'READY');
      await search();
      expect(lexicalSkipped()).toBe(false);
    });

    it('answers INDEX_NOT_READY with the vector state when neither leg can run', async () => {
      plant('BUILDING', null);
      expect(codeOf(await search())).toMatchObject({
        code: 'INDEX_NOT_READY',
        state: 'building',
      });
    });
  });
});

describe('answers with no index state bound', () => {
  it('keeps both legs and the cold path as today', async () => {
    // As in a host application that composes news-core without the index state.
    const api = await bootNewsApi({
      override: (builder) =>
        builder.overrideProvider(SEARCH_INDEX_STATE).useValue(null),
    });
    try {
      const body = (
        await api.gql<unknown>(COLD_TOPIC, { t: 'no binding topic' })
      ).body;
      expect(body.errors).toBeUndefined();
    } finally {
      await api.close();
    }
  });
});
