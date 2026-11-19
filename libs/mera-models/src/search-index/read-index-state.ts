import type { IndexState } from '@mera/shared/health/search-index-state';
import {
  VECTOR_INDEX_NAME,
  VECTOR_PATH,
  type SearchIndexField,
} from './retrieval-index';
import type {
  ListedSearchIndex,
  SearchIndexAdmin,
} from './search-index-admin.port';

export interface IndexReading {
  state: IndexState;
  /** The vector size the index holds, set with `dims_mismatch`. */
  actualDims?: number;
}

const RESOLUTION =
  'Change model or start over: set the model and EMBEDDING_DIMS back to what the database was built with, or drop the index and build it again at the new size with a new database.';

const sameField = (actual: Record<string, unknown>, want: SearchIndexField) =>
  Object.entries(want).every(([key, value]) => actual[key] === value);

/**
 * Reads one index's state from a single `list` answer. `expected` is the
 * definition a vector index must contain (extra fields in the actual index are
 * fine); without it the index is judged on presence and `queryable` only, which
 * is how the text index is read. A list that throws reads `unreadable`.
 */
export async function readIndexState(
  admin: Pick<SearchIndexAdmin, 'list'>,
  name: string,
  expected?: { fields: SearchIndexField[] },
): Promise<IndexReading> {
  let rows: ListedSearchIndex[];
  try {
    rows = await admin.list();
  } catch {
    return { state: 'unreadable' };
  }
  const found = rows.find((row) => row.name === name);
  if (!found) return { state: 'missing' };
  // Going or gone: the worker may build it again, as for no index at all.
  if (found.status === 'DOES_NOT_EXIST' || found.status === 'DELETING') {
    return { state: 'missing' };
  }
  // STALE answers queries but no longer takes writes, so new articles are
  // silently absent: as broken as a failed build, and fixed the same way.
  if (found.status === 'FAILED' || found.status === 'STALE') {
    return { state: 'failed' };
  }
  // Any other state without `queryable` is still on its way (PENDING, BUILDING).
  if (!found.queryable) return { state: 'building' };
  if (!expected) return { state: 'ready' };

  const fields = ((found.latestDefinition as { fields?: unknown } | undefined)
    ?.fields ?? []) as Record<string, unknown>[];
  const vector = fields.find(
    (field) => field.type === 'vector' && field.path === VECTOR_PATH,
  );
  const wantDims = expected.fields.find(
    (field) => field.path === VECTOR_PATH,
  )?.numDimensions;
  if (
    typeof vector?.numDimensions === 'number' &&
    vector.numDimensions !== wantDims
  ) {
    return { state: 'dims_mismatch', actualDims: vector.numDimensions };
  }
  const complete = expected.fields.every((want) =>
    fields.some((actual) => sameField(actual, want)),
  );
  return { state: complete ? 'ready' : 'outdated' };
}

/** Only a vector size that disagrees with the configuration stops a boot; every other state logs and continues. */
export function assertBootIndexState(
  reading: IndexReading,
  expectedDims: number,
): void {
  if (reading.state !== 'dims_mismatch') return;
  throw new Error(
    `The vector index "${VECTOR_INDEX_NAME}" holds ${reading.actualDims} dimensions, but EMBEDDING_DIMS is ${expectedDims}. ${RESOLUTION}`,
  );
}
