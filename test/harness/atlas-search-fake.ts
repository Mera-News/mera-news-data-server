import mongoose from 'mongoose';
import indexes from './atlas-search-fake.indexes.json';

/**
 * An in-memory stand-in for MongoDB `$vectorSearch`. The in-memory database has
 * no search index, so this wraps `Aggregate.exec`, ranks the candidates itself
 * (exact cosine, no approximation) and rewrites the stage into plain operators.
 * It refuses everything the real service would treat differently.
 */
export interface VectorSearchCall {
  collection: string;
  index: string;
  path: string;
  limit: number;
  numCandidates: number;
  filter: unknown;
}

interface IndexField {
  type: string;
  path: string;
  numDimensions?: number;
  similarity?: string;
}
interface IndexDefinition {
  collection: string;
  name: string;
  definition: { fields: IndexField[] };
}

const STAGE_KEYS = [
  'index',
  'path',
  'queryVector',
  'numCandidates',
  'limit',
  'filter',
];
const FILTER_OPERATORS = new Set([
  '$and',
  '$or',
  '$nor',
  '$not',
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$exists',
]);
const FORBIDDEN_STAGES = ['$search', '$searchMeta', '$listSearchIndexes'];

type Exec = typeof mongoose.Aggregate.prototype.exec;
type Pipeline = Record<string, any>[];

let installed: Exec | undefined;

function refuse(reason: string): never {
  throw new Error(
    `atlas-search-fake: ${reason}. Cover this case in the end-to-end tests that run against a real database.`,
  );
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  Object.getPrototypeOf(v) === Object.prototype;

/** Throws on any `$meta` other than `vectorSearchScore`; returns whether one is present. */
function scanMeta(node: unknown): boolean {
  if (Array.isArray(node)) return node.map(scanMeta).some(Boolean);
  if (!isPlainObject(node)) return false;
  let found = false;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$meta') {
      if (value !== 'vectorSearchScore')
        refuse(`$meta ${JSON.stringify(value)} is not supported`);
      found = true;
    } else found = scanMeta(value) || found;
  }
  return found;
}

function replaceMeta(node: unknown, score: unknown): unknown {
  if (Array.isArray(node)) return node.map((n) => replaceMeta(n, score));
  if (!isPlainObject(node)) return node;
  if (node.$meta === 'vectorSearchScore') return score;
  return Object.fromEntries(
    Object.entries(node).map(([k, v]) => [k, replaceMeta(v, score)]),
  );
}

function checkFilter(node: unknown, filterPaths: Set<string>): void {
  if (Array.isArray(node))
    return node.forEach((n) => checkFilter(n, filterPaths));
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('$')) {
      if (!FILTER_OPERATORS.has(key))
        refuse(`filter operator ${key} is not supported`);
    } else if (!filterPaths.has(key)) {
      refuse(
        `filter field "${key}" is not declared as a filter field in the index`,
      );
    }
    checkFilter(value, filterPaths);
  }
}

function cosine(a: number[], b: number[]): number | undefined {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? undefined : dot / Math.sqrt(na * nb);
}

async function rewrite(
  aggregate: mongoose.Aggregate<unknown>,
  calls: VectorSearchCall[],
) {
  const pipeline = aggregate.pipeline() as Pipeline;
  const model = aggregate.model() as mongoose.Model<unknown> | undefined;
  if (!model)
    refuse('an aggregate with $vectorSearch must be bound to a model');
  const collection = model.collection.collectionName;

  const stage: unknown = pipeline[0].$vectorSearch;
  if (!isPlainObject(stage)) refuse('$vectorSearch must be an object');
  for (const key of Object.keys(stage)) {
    if (!STAGE_KEYS.includes(key))
      refuse(`$vectorSearch key "${key}" is not supported`);
  }

  const index = (indexes as IndexDefinition[]).find(
    (i) => i.name === stage.index,
  );
  if (!index || index.collection !== collection) {
    refuse(
      `index ${JSON.stringify(stage.index)} is not defined for collection ${collection}`,
    );
  }
  const vectorField = index.definition.fields.find((f) => f.type === 'vector')!;
  if (vectorField.similarity !== 'cosine')
    refuse(`similarity ${vectorField.similarity} is not supported`);
  if (stage.path !== vectorField.path)
    refuse(
      `path ${JSON.stringify(stage.path)} is not the indexed vector field`,
    );

  const query = stage.queryVector;
  if (
    !Array.isArray(query) ||
    query.length !== vectorField.numDimensions ||
    !query.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    refuse(`queryVector must be ${vectorField.numDimensions} finite numbers`);
  }
  const { limit, numCandidates } = stage;
  if (!Number.isInteger(limit) || (limit as number) < 1)
    refuse('limit must be a positive integer');
  if (
    !Number.isInteger(numCandidates) ||
    (numCandidates as number) < (limit as number) ||
    (numCandidates as number) > 10000
  ) {
    refuse('numCandidates must be an integer from limit to 10000');
  }
  const filterPaths = new Set(
    index.definition.fields
      .filter((f) => f.type === 'filter')
      .map((f) => f.path),
  );
  checkFilter(stage.filter, filterPaths);

  const path = stage.path as string;
  const docs = await model.collection
    .find(
      {
        $and: [(stage.filter as object) ?? {}, { [path]: { $type: 'array' } }],
      },
      { projection: { _id: 1, [path]: 1 } },
    )
    .toArray();
  const ranked = docs
    .flatMap((doc) => {
      const vector = doc[path] as unknown;
      if (!Array.isArray(vector) || vector.length !== query.length) return [];
      const cos = cosine(query as number[], vector as number[]);
      return cos === undefined
        ? []
        : [{ id: doc._id, hex: String(doc._id), score: (1 + cos) / 2 }];
    })
    .sort(
      (a, b) =>
        b.score - a.score || (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0),
    )
    .slice(0, limit as number);

  const ids = ranked.map((r) => r.id);
  const lookup = {
    $arrayElemAt: [
      { $literal: ranked.map((r) => r.score) },
      { $indexOfArray: [{ $literal: ids }, '$_id'] },
    ],
  };
  const rest = replaceMeta(pipeline.slice(1), lookup) as Pipeline;
  pipeline.splice(
    0,
    pipeline.length,
    { $match: { _id: { $in: ids } } },
    { $set: { __fakeRank: { $indexOfArray: [{ $literal: ids }, '$_id'] } } },
    { $sort: { __fakeRank: 1 } },
    { $unset: '__fakeRank' },
    ...rest,
  );
  calls.push({
    collection,
    index: index.name,
    path,
    limit: limit as number,
    numCandidates: numCandidates as number,
    filter: stage.filter,
  });
}

export function installAtlasSearchFake(): {
  calls: VectorSearchCall[];
  uninstall(): void;
} {
  if (installed) throw new Error('atlas-search-fake: already installed');
  // Always re-applied with the aggregate as `this`.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = mongoose.Aggregate.prototype.exec;
  const calls: VectorSearchCall[] = [];
  installed = original;

  mongoose.Aggregate.prototype.exec = async function (
    this: mongoose.Aggregate<unknown>,
    ...args: []
  ) {
    const pipeline = this.pipeline() as Pipeline;
    const keys = (s: Pipeline[number]) => Object.keys(s);
    for (const s of pipeline) {
      for (const forbidden of FORBIDDEN_STAGES) {
        if (keys(s).includes(forbidden))
          refuse(`${forbidden} is not supported`);
      }
    }
    const at = pipeline.findIndex((s) => keys(s).includes('$vectorSearch'));
    if (at > 0) refuse('$vectorSearch must be the first stage');
    const hasScore = scanMeta(pipeline);
    if (at < 0) {
      if (hasScore)
        refuse('vectorSearchScore needs $vectorSearch as the first stage');
      return original.apply(this, args) as Promise<unknown>;
    }
    await rewrite(this, calls);
    return original.apply(this, args) as Promise<unknown>;
  } as Exec;

  return {
    calls,
    uninstall() {
      mongoose.Aggregate.prototype.exec = original;
      installed = undefined;
    },
  };
}
