/**
 * EmbeddingProvider port (ports & adapters — business logic never imports the
 * Jina SDK directly). Defaults to the `retrieval.query` task — this
 * is the GraphQL-side inline embedding call used by the interactive topic-add
 * mutation and Flow v2's vector-search fallback (v1-port: the ONNX
 * HTTP hop to mera-server-async was removed, so all query-time tasks route
 * through this one port). The symmetric text-matching task was dropped from
 * this union once its `searchArticlesVector` vector-search mode was removed
 * — the corresponding Atlas index no longer exists. The article field that
 * task used to embed is still written by the async pipeline and read
 * directly from Mongo by the Python HDBSCAN clustering job; only this app's
 * query-time embedding task was narrowed.
 */
export const EMBEDDING_PROVIDER = 'EMBEDDING_PROVIDER';

export type EmbeddingTask = 'retrieval.passage' | 'retrieval.query';

export interface EmbeddingProvider {
  /** Embed `texts` (default task `retrieval.query`); one 768-dim vector each, aligned to input order. */
  embed(
    texts: string[],
    signal?: AbortSignal,
    task?: EmbeddingTask,
  ): Promise<number[][]>;
}
