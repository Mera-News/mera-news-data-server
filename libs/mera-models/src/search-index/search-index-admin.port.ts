import type { SearchIndexSpec } from './retrieval-index';

export type { SearchIndexSpec };

/** One row of `$listSearchIndexes`, the parts this server reads. */
export interface ListedSearchIndex {
  name: string;
  type?: string;
  status?: string;
  queryable?: boolean;
  latestDefinition?: Record<string, unknown>;
}

/**
 * The search index commands on `news-article`. A port because the in-memory
 * database rejects `$listSearchIndexes`, so the test harness binds its own.
 */
export interface SearchIndexAdmin {
  list(): Promise<ListedSearchIndex[]>;
  /** Answers code 48 when the collection already exists. */
  createCollection(name: string): Promise<void>;
  /** Answers code 68 when an index of that name already exists. */
  create(spec: SearchIndexSpec): Promise<void>;
}

export const SEARCH_INDEX_ADMIN = 'SEARCH_INDEX_ADMIN';
