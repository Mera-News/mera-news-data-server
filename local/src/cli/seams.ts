import type { Embedder } from '../embed/embedder.ts';
import type { Store } from '../store/store.ts';
import { searchArticles } from '../serve/retrieval.ts';
import { runServe } from '../serve/run.ts';

/** What `search` needs from src/serve/retrieval.ts. */
export interface SearchHit {
  id: string;
  title: string;
  articleUrl: string;
  publicationName: string;
  pubDate: string;
  languageCode: string | null;
}
export type SearchFn = (
  store: Store,
  embedder: Embedder,
  query: string,
  opts: { limit: number },
) => Promise<{ hits: SearchHit[]; empty: 'no_articles_yet' | 'no_match' | null }>;

/** What `serve` needs from src/serve/run.ts. */
export type ServeFn = (options: {
  store: Store;
  embedder: Embedder;
  port?: number;
  every?: number;
  ingest?: () => Promise<unknown>;
  onEvent: (event: Record<string, unknown>) => void;
}) => Promise<void>;

export async function loadSearch(): Promise<SearchFn> {
  return searchArticles;
}

export async function loadServe(): Promise<ServeFn> {
  return runServe;
}
