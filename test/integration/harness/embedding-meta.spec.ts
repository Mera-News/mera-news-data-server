import { Logger } from '@nestjs/common';
import mongoose, { type Connection } from 'mongoose';
import type { Db } from 'mongodb';
import { checkEmbeddingMeta } from '../../../libs/mera-shared/src/embedding-provider/embedding-meta';

type Env = Record<string, string>;
const reader = (env: Env) => ({
  get: <T>(key: string) => env[key] as T | undefined,
});

const FAKE: Env = { EMBEDDING_PROVIDER: 'fake' };
const DEFAULT_MODEL = 'jina-embeddings-v5-text-nano';

describe('embedding meta document', () => {
  let connection: Connection;
  let db: Db;
  let lines: string[];

  beforeAll(async () => {
    connection = await mongoose
      .createConnection(process.env.MONGODB_URI!)
      .asPromise();
    db = connection.db!;
  });

  afterAll(async () => {
    await connection.close();
  });

  beforeEach(async () => {
    for (const c of await db.collections()) await c.deleteMany({});
    lines = [];
    const push = (m: unknown) => lines.push(String(m));
    Logger.overrideLogger({
      log: push,
      error: push,
      warn: push,
      debug: push,
      verbose: push,
    });
  });

  afterEach(() => {
    Logger.overrideLogger(false);
  });

  const meta = () => db.collection<{ _id: string }>('deployment-meta');
  const stored = () => meta().findOne({ _id: 'embedding' });
  const check = (env: Env, write: boolean, target: Db = db) =>
    checkEmbeddingMeta(target, reader(env), { write });
  const save = (doc: Record<string, unknown>) =>
    meta().insertOne({ _id: 'embedding', ...doc });

  it('records provider, model, dims and createdAt on the first checked start', async () => {
    await check(FAKE, true);

    expect(await stored()).toMatchObject({
      provider: 'fake',
      model: DEFAULT_MODEL,
      dims: 768,
      createdAt: expect.any(Date),
    });
  });

  it('writes nothing in compare-only mode, with or without a document', async () => {
    await check(FAKE, false);
    expect(await stored()).toBeNull();

    await save({ provider: 'fake', model: DEFAULT_MODEL, dims: 768 });
    await check(FAKE, false);
    expect(await meta().countDocuments()).toBe(1);
  });

  it('names the model of a jina or fake provider from JINA_MODEL', async () => {
    await check({ ...FAKE, JINA_MODEL: 'other-model' }, true);

    expect(await stored()).toMatchObject({ model: 'other-model' });
  });

  it('names the model of the OpenAI-compatible provider from EMBEDDING_MODEL', async () => {
    await check(
      {
        EMBEDDING_PROVIDER: 'openai-compatible',
        EMBEDDING_MODEL: 'bge-small',
        JINA_MODEL: 'ignored',
        EMBEDDING_DIMS: '384',
      },
      true,
    );

    expect(await stored()).toMatchObject({
      provider: 'openai-compatible',
      model: 'bge-small',
      dims: 384,
    });
  });

  it('refuses a different model and names both', async () => {
    await save({ provider: 'fake', model: DEFAULT_MODEL, dims: 768 });

    const refused = check({ ...FAKE, JINA_MODEL: 'other-model' }, false);

    await expect(refused).rejects.toThrow(DEFAULT_MODEL);
    await expect(refused).rejects.toThrow('other-model');
    await expect(refused).rejects.toThrow('Change model or start over');
  });

  it('refuses different dims and names both', async () => {
    await save({ provider: 'fake', model: DEFAULT_MODEL, dims: 768 });

    const refused = check({ ...FAKE, EMBEDDING_DIMS: '1024' }, true);

    await expect(refused).rejects.toThrow('768');
    await expect(refused).rejects.toThrow('1024');
  });

  it('never compares the provider, so the same model through another adapter starts', async () => {
    await save({ provider: 'jina', model: 'bge-small', dims: 768 });

    await expect(
      check(
        {
          EMBEDDING_PROVIDER: 'openai-compatible',
          EMBEDDING_MODEL: 'bge-small',
        },
        true,
      ),
    ).resolves.toBeUndefined();
    expect(await stored()).toMatchObject({ provider: 'jina' });
  });

  describe('first write over stored vectors', () => {
    const article = (vector?: number[]) =>
      db
        .collection('news-article')
        .insertOne(
          vector === undefined
            ? {}
            : { embedding_article_data_retrieval: vector },
        );

    it('refuses vectors of another length and writes no document', async () => {
      await article([0.1, 0.2, 0.3]);

      const refused = check(FAKE, true);

      await expect(refused).rejects.toThrow('3');
      await expect(refused).rejects.toThrow('768');
      expect(await stored()).toBeNull();
    });

    it('records the document when the stored vectors fit', async () => {
      await article(Array.from({ length: 768 }, () => 0.1));

      await check(FAKE, true);

      expect(await stored()).toMatchObject({ dims: 768 });
    });

    it('ignores articles that have no vector yet', async () => {
      await article();

      await check(FAKE, true);

      expect(await stored()).toMatchObject({ dims: 768 });
    });

    // The schema defaults the field to [], so every article that is not
    // embedded yet holds an empty array: a normal state of every database.
    it('ignores an article whose vector is still the empty default', async () => {
      await article([]);
      await article(Array.from({ length: 768 }, () => 0.1));

      await check(FAKE, true);

      expect(await stored()).toMatchObject({ dims: 768 });
    });

    it('starts when every article still has the empty default', async () => {
      await article([]);

      await check(FAKE, true);

      expect(await stored()).toMatchObject({ dims: 768 });
    });

    it('ignores an article whose vector field is null', async () => {
      await db
        .collection('news-article')
        .insertOne({ embedding_article_data_retrieval: null });

      await check(FAKE, true);

      expect(await stored()).toMatchObject({ dims: 768 });
    });

    it('does not look at the articles in compare-only mode', async () => {
      await article([0.1]);

      await expect(check(FAKE, false)).resolves.toBeUndefined();
    });
  });

  describe('two processes racing to write', () => {
    // The loser read an empty collection, then the winner inserted: the
    // first findOne answers null, every later one the real document.
    const racing = (): Db => {
      let reads = 0;
      const real = meta();
      return {
        collection: (name: string) =>
          name === 'deployment-meta'
            ? {
                findOne: (...args: Parameters<typeof real.findOne>) =>
                  reads++ === 0 ? Promise.resolve(null) : real.findOne(...args),
                insertOne: real.insertOne.bind(real),
              }
            : db.collection(name),
      } as unknown as Db;
    };

    it("compares the winner's document and refuses a different model", async () => {
      await save({ provider: 'fake', model: 'winner-model', dims: 768 });

      await expect(check(FAKE, true, racing())).rejects.toThrow('winner-model');
    });

    it("starts when the winner's document matches", async () => {
      await save({ provider: 'fake', model: DEFAULT_MODEL, dims: 768 });

      await expect(check(FAKE, true, racing())).resolves.toBeUndefined();
    });
  });

  it('logs a database error at error level and continues', async () => {
    const broken = {
      collection: () => ({
        findOne: () => Promise.reject(new Error('no route to host')),
      }),
    } as unknown as Db;

    await expect(check(FAKE, true, broken)).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes('no route to host'))).toBe(true);
  });
});
