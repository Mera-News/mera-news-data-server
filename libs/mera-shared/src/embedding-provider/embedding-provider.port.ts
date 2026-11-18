/**
 * EmbeddingProvider port (ports & adapters — business logic never imports the
 * Jina SDK). One call embeds a batch of texts under a given Jina task and
 * returns vectors of `EMBEDDING_DIMS` values (768 by default) aligned to the
 * input order. The batch sizing
 * (Decision 2: ~500–1,000 texts/request, 2–3 in flight) is owned by the
 * MicroBatcher in the embedding service; the adapter just issues one request.
 *
 * `task` is per-call so one provider instance serves both the metadata-enriched
 * `retrieval.passage` vector and the metadata-free `text-matching` vector (v1
 * parity — the two vectors have different downstream uses).
 */
export const EMBEDDING_PROVIDER = 'EMBEDDING_PROVIDER';

export type EmbeddingTask =
  | 'retrieval.passage'
  | 'retrieval.query'
  | 'text-matching';

export interface EmbeddingProvider {
  /** Embed `texts` under `task`; returns one vector of `EMBEDDING_DIMS` values each, in order. */
  embed(
    texts: string[],
    task: EmbeddingTask,
    signal?: AbortSignal,
  ): Promise<number[][]>;
}
