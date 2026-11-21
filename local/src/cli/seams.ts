import type { Embedder } from '../embed/embedder.ts';
import type { Store } from '../store/store.ts';
import { CliError } from './errors.ts';

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
  onEvent: (event: Record<string, unknown>) => void;
}) => Promise<void>;

// The import sits in a try block so the bundle still builds while the file is missing
// (esbuild turns an unresolved import in a try into a warning), and the path is ignored by
// the typecheck for the same reason.
export async function loadSearch(): Promise<SearchFn> {
  try {
    // @ts-ignore the module may not exist yet
    const mod = await import('../serve/retrieval.ts');
    return mod.searchArticles as SearchFn;
  } catch (error) {
    throw notBuilt('search', error);
  }
}

export async function loadServe(): Promise<ServeFn> {
  try {
    // @ts-ignore the module may not exist yet
    const mod = await import('../serve/run.ts');
    return mod.runServe as ServeFn;
  } catch (error) {
    throw notBuilt('serve', error);
  }
}

// Only a missing file counts as "not built"; a real failure inside the module must surface.
function notBuilt(what: string, error: unknown): Error {
  const e = error as { code?: string; message?: string };
  if (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND') {
    return new CliError('not_built_yet', `The ${what} command is not built in this version yet.`);
  }
  return error as Error;
}
