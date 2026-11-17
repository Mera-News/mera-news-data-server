// Single source of truth for the Atlas Vector Search relevance floor on
// the `embedding_article_data_retrieval` (retrieval.passage) space. Bumped
// 0.76 → 0.78 (score-distribution audit, 2026-07-17): the world-weather /
// world-politics junk tail on the retrieval vectors lives at 0.745–0.78,
// while healthy topics separate cleanly at ~0.785; EU-AI-Act-class topics
// still keep ≥40 candidates above 0.78. 0.76 was nearly inert (top-100 ANN
// floors already sit at 0.745–0.754), so it trimmed almost nothing. Consumed
// by article retrieval (`articles-for-topics.service.ts`), cluster retrieval
// (`news-cluster.service.ts`), and the async data-retrieval search
// (`apps/mera-server-async/src/constants.ts`) so the three stay in lockstep.
export const VECTOR_RETRIEVAL_MIN_SCORE = 0.78;
