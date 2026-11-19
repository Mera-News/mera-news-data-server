import { assertBootIndexState, readIndexState } from './read-index-state';
import {
  retrievalIndexDefinition,
  textIndexDefinition,
  VECTOR_INDEX_NAME,
} from './retrieval-index';
import type { ListedSearchIndex } from './search-index-admin.port';

const vector = retrievalIndexDefinition(768);
const text = textIndexDefinition();

const listed = (over: Partial<ListedSearchIndex> = {}): ListedSearchIndex => ({
  name: VECTOR_INDEX_NAME,
  type: 'vectorSearch',
  status: 'READY',
  queryable: true,
  latestDefinition: vector.definition,
  ...over,
});

const read = (rows: ListedSearchIndex[], name = VECTOR_INDEX_NAME) =>
  readIndexState(
    { list: () => Promise.resolve(rows) },
    name,
    name === VECTOR_INDEX_NAME ? vector.definition : undefined,
  );

const withFields = (fields: unknown[]) =>
  listed({ latestDefinition: { fields } as never });

describe('readIndexState', () => {
  it('reads the hosted shape as ready', async () => {
    expect((await read([listed()])).state).toBe('ready');
  });

  it('reads an index with extra fields as ready', async () => {
    const extra = withFields([
      ...vector.definition.fields,
      { type: 'filter', path: 'language_code' },
    ]);
    expect((await read([extra])).state).toBe('ready');
  });

  it('reads no index of that name as missing', async () => {
    expect((await read([])).state).toBe('missing');
    expect((await read([listed({ name: 'another' })])).state).toBe('missing');
  });

  it('reads a queryable index without a filter field as outdated', async () => {
    const [vectorField] = vector.definition.fields;
    expect((await read([withFields([vectorField])])).state).toBe('outdated');
  });

  it('reads another vector size as dims_mismatch and keeps the size', async () => {
    const [, filter] = vector.definition.fields;
    const reading = await read([
      withFields([
        { ...vector.definition.fields[0], numDimensions: 1024 },
        filter,
      ]),
    ]);
    expect(reading).toEqual({ state: 'dims_mismatch', actualDims: 1024 });
  });

  it('reads another similarity as outdated, not dims_mismatch', async () => {
    const [vectorField, filter] = vector.definition.fields;
    const reading = await read([
      withFields([{ ...vectorField, similarity: 'euclidean' }, filter]),
    ]);
    expect(reading.state).toBe('outdated');
  });

  it('reads a vector under another path as outdated', async () => {
    const [vectorField, filter] = vector.definition.fields;
    const reading = await read([
      withFields([{ ...vectorField, path: 'another_embedding' }, filter]),
    ]);
    expect(reading.state).toBe('outdated');
  });

  it('reads a size that is not a number as outdated', async () => {
    const [vectorField, filter] = vector.definition.fields;
    const reading = await read([
      withFields([{ ...vectorField, numDimensions: '1024' }, filter]),
    ]);
    expect(reading.state).toBe('outdated');
  });

  it('reads a queryable index that lists no definition as outdated', async () => {
    expect((await read([listed({ latestDefinition: undefined })])).state).toBe(
      'outdated',
    );
  });

  it('reads PENDING and BUILDING as building', async () => {
    for (const status of ['PENDING', 'BUILDING']) {
      const row = listed({ status, queryable: false });
      expect((await read([row])).state).toBe('building');
    }
  });

  it('reads FAILED as failed, queryable or not', async () => {
    expect(
      (await read([listed({ status: 'FAILED', queryable: false })])).state,
    ).toBe('failed');
    expect((await read([listed({ status: 'FAILED' })])).state).toBe('failed');
  });

  it('reads DOES_NOT_EXIST and DELETING as missing', async () => {
    for (const status of ['DOES_NOT_EXIST', 'DELETING']) {
      const row = listed({ status, queryable: false });
      expect((await read([row])).state).toBe('missing');
    }
  });

  // STALE is queryable but has stopped taking writes: new articles would be
  // silently absent from every answer.
  it('reads STALE as failed, although it is still queryable', async () => {
    expect((await read([listed({ status: 'STALE' })])).state).toBe('failed');
  });

  it('reads a status it does not know, not queryable, as building', async () => {
    const row = listed({ status: 'SOMETHING_NEW', queryable: false });
    expect((await read([row])).state).toBe('building');
  });

  it('reads a list that throws as unreadable', async () => {
    const reading = await readIndexState(
      { list: () => Promise.reject(new Error('not authorized')) },
      VECTOR_INDEX_NAME,
      vector.definition,
    );
    expect(reading.state).toBe('unreadable');
  });

  describe('the text index', () => {
    const row = (over: Partial<ListedSearchIndex> = {}): ListedSearchIndex => ({
      name: text.name,
      type: 'search',
      status: 'READY',
      queryable: true,
      latestDefinition: { mappings: { dynamic: true } } as never,
      ...over,
    });

    it('is ready on presence alone, whatever its definition', async () => {
      expect((await read([row()], text.name)).state).toBe('ready');
    });

    it('reads missing, building and failed', async () => {
      expect((await read([], text.name)).state).toBe('missing');
      expect(
        (await read([row({ status: 'PENDING', queryable: false })], text.name))
          .state,
      ).toBe('building');
      expect(
        (await read([row({ status: 'FAILED', queryable: false })], text.name))
          .state,
      ).toBe('failed');
    });
  });
});

describe('assertBootIndexState', () => {
  it('throws on dims_mismatch, naming both sizes and the way out', () => {
    expect(() =>
      assertBootIndexState({ state: 'dims_mismatch', actualDims: 1024 }, 768),
    ).toThrow(/1024.*768.*Change model or start over/s);
  });

  it.each([
    'missing',
    'building',
    'failed',
    'ready',
    'outdated',
    'unreadable',
  ] as const)('lets %s through', (state) => {
    expect(() => assertBootIndexState({ state }, 768)).not.toThrow();
  });
});
