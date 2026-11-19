/** Where a search index stands, as read from the cluster. */
export type IndexState =
  | 'missing'
  | 'building'
  | 'failed'
  | 'ready'
  | 'outdated'
  | 'dims_mismatch'
  | 'unreadable';

export interface IndexStatus {
  state: IndexState;
  /** What the operator can do about it, in plain words. */
  detail: string;
}

/**
 * The two search indexes this server queries. Every caller reads through one
 * 30 second cache, so a state is never older than that.
 */
export interface SearchIndexState {
  vector(): Promise<IndexState>;
  text(): Promise<IndexState>;
  report(): Promise<{ vectorIndex: IndexStatus; textIndex: IndexStatus }>;
}

export const SEARCH_INDEX_STATE = 'SEARCH_INDEX_STATE';

/**
 * Vector states a query must not run against: it would answer nothing and look
 * like "no news". `unreadable` is not here: a server that cannot read the list
 * runs as it always has.
 */
export const VECTOR_NOT_READY: readonly IndexState[] = [
  'missing',
  'building',
  'failed',
  'outdated',
  'dims_mismatch',
];

/** Text states the lexical search leg is skipped for. The text index is judged on presence only. */
export const TEXT_NOT_READY: readonly IndexState[] = [
  'missing',
  'building',
  'failed',
];
