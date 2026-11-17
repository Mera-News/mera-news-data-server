import mongoose, {
  Schema,
  type Connection,
  type Model,
  type PipelineStage,
  Types,
} from 'mongoose';
import { installAtlasSearchFake } from '../../../harness/atlas-search-fake';
import { harnessMongoUri } from '../../../harness/env';

const INDEX = 'embedding_article_data_retrieval_index';
const PATH = 'embedding_article_data_retrieval';
const DIMS = 768;

const unit = (...head: number[]) => [
  ...head,
  ...new Array<number>(DIMS - head.length).fill(0),
];

describe('atlas-search-fake', () => {
  let connection: Connection;
  let model: Model<any, any, any, any, any, any, any>;
  let fake: ReturnType<typeof installAtlasSearchFake>;

  const stage = (overrides: Record<string, unknown> = {}) => ({
    $vectorSearch: {
      index: INDEX,
      path: PATH,
      queryVector: unit(1),
      numCandidates: 100,
      limit: 10,
      ...overrides,
    },
  });
  const run = (...pipeline: object[]) =>
    model.aggregate(pipeline as PipelineStage[]).exec();
  const rejects = (...pipeline: object[]) =>
    expect(run(...pipeline)).rejects.toThrow(
      /^atlas-search-fake: .*end-to-end/,
    );

  beforeAll(async () => {
    connection = await mongoose.createConnection(harnessMongoUri()).asPromise();
    model = connection.model(
      'FakeArticle',
      new Schema({}, { strict: false }),
      'news-article',
    );
  });
  beforeEach(async () => {
    await model.collection.deleteMany({});
    fake = installAtlasSearchFake();
  });
  afterEach(() => fake.uninstall());
  afterAll(async () => {
    await model.collection.deleteMany({});
    await connection.close();
  });

  it('scores identical, orthogonal and opposite vectors 1, 0.5 and 0', async () => {
    await model.collection.insertMany([
      { name: 'same', [PATH]: unit(2) },
      { name: 'orthogonal', [PATH]: unit(0, 3) },
      { name: 'opposite', [PATH]: unit(-4) },
    ]);
    const rows = await run(stage(), {
      $addFields: { score: { $meta: 'vectorSearchScore' } },
    });
    expect(rows.map((r) => [r.name, r.score])).toEqual([
      ['same', 1],
      ['orthogonal', 0.5],
      ['opposite', 0],
    ]);
    expect(fake.calls).toEqual([
      {
        collection: 'news-article',
        index: INDEX,
        path: PATH,
        limit: 10,
        numCandidates: 100,
        filter: undefined,
      },
    ]);
  });

  it('returns matches in descending order and honours limit', async () => {
    await model.collection.insertMany([
      { name: 'c', [PATH]: unit(1, 3) },
      { name: 'a', [PATH]: unit(1, 0.1) },
      { name: 'b', [PATH]: unit(1, 1) },
    ]);
    const rows = await run(stage({ limit: 2, numCandidates: 2 }));
    expect(rows.map((r) => r.name)).toEqual(['a', 'b']);
  });

  it('breaks score ties by ascending _id', async () => {
    const low = new Types.ObjectId('000000000000000000000001');
    const high = new Types.ObjectId('000000000000000000000002');
    await model.collection.insertMany([
      { _id: high, [PATH]: unit(1) },
      { _id: low, [PATH]: unit(1) },
    ]);
    const rows = await run(stage());
    expect(rows.map((r) => String(r._id))).toEqual([String(low), String(high)]);
  });

  it('excludes an old document with a createdAt $gte filter', async () => {
    await model.collection.insertMany([
      { name: 'old', createdAt: new Date('2020-01-01'), [PATH]: unit(1) },
      { name: 'new', createdAt: new Date(), [PATH]: unit(1) },
    ]);
    const rows = await run(
      stage({ filter: { createdAt: { $gte: new Date('2024-01-01') } } }),
    );
    expect(rows.map((r) => r.name)).toEqual(['new']);
  });

  it('skips documents without a usable vector', async () => {
    await model.collection.insertMany([
      { name: 'none' },
      { name: 'short', [PATH]: [1, 0] },
      { name: 'zero', [PATH]: unit() },
      { name: 'ok', [PATH]: unit(1) },
    ]);
    const rows = await run(stage());
    expect(rows.map((r) => r.name)).toEqual(['ok']);
  });

  it('passes a pipeline without $vectorSearch through untouched', async () => {
    await model.collection.insertOne({ name: 'plain' });
    expect((await run({ $match: { name: 'plain' } })).length).toBe(1);
    expect(fake.calls).toEqual([]);
  });

  it('throws when installed twice', () => {
    expect(() => installAtlasSearchFake()).toThrow(/already installed/);
  });

  it('throws on a filter field that is not declared in the index', () =>
    rejects(stage({ filter: { url_security_state: { $eq: 'ok' } } })));
  it('throws on exact: true', () => rejects(stage({ exact: true })));
  it('throws on a vector with 767 dimensions', () =>
    rejects(stage({ queryVector: new Array<number>(767).fill(1) })));
  it('throws when numCandidates is below limit', () =>
    rejects(stage({ numCandidates: 5, limit: 10 })));
  it('throws on a $search stage', () =>
    rejects({ $search: { text: { query: 'x', path: 'title' } } }));
  it('throws when $vectorSearch is not the first stage', () =>
    rejects({ $match: {} }, stage()));
  it("throws on $meta: 'searchScore'", () =>
    rejects(stage(), { $addFields: { score: { $meta: 'searchScore' } } }));
  it('throws on an unknown index', () => rejects(stage({ index: 'nope' })));

  it('rejects $vectorSearch after uninstall', async () => {
    fake.uninstall();
    await expect(run(stage())).rejects.toThrow();
    fake = installAtlasSearchFake();
  });
});
