/**
 * Default page size for every cursor-paginated news query.
 *
 * Lives in the lib rather than the app because both the app-facing API and the
 * internal news relay page the same collections, and a value that drifted
 * between them would silently change what a caller gets back per page.
 */
export const DEFAULT_PAGE_SIZE = 20;

/**
 * `$project` exclusion for every news-article aggregate that does not already
 * project by inclusion. `Model.aggregate()` bypasses Mongoose `select: false`,
 * so without it each row carries every embedding and both packed sidecars
 * (~21.9 KB) onto a 1 GiB heap. Exclusion rather than inclusion keeps the
 * description fields the must-match filter reads; it fails CLOSED, so a
 * projection that drops them silently empties a followed story.
 */
export const HEAVY_ARTICLE_FIELDS_EXCLUSION = {
  embedding_article_data_retrieval: 0,
  // The pipeline writes the unsuffixed text-matching field; `_internal_only` covers
  // stray v3-drift docs.
  embedding_article_data_text_matching: 0,
  embedding_article_data_text_matching_internal_only: 0,
  vector_sidecar_packed: 0,
  vector_sidecar_tm_packed: 0,
} as const;
