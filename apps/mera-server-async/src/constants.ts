import { VECTOR_RETRIEVAL_MIN_SCORE } from '@mera/shared';

// --- Vector Search: Data Retrieval (asymmetric: query → article, topic linking) ---
// Bumped 0.76 → 0.78 (score-distribution audit, 2026-07-17): the world-weather /
// world-politics junk tail on the retrieval vectors lives at 0.745–0.78, while
// healthy topics separate cleanly at ~0.785; EU-AI-Act-class topics still keep
// ≥40 candidates above 0.78. 0.76 was nearly inert (top-100 ANN floors already
// sit at 0.745–0.754), so it trimmed almost nothing.
// The value lives in @mera/shared (VECTOR_RETRIEVAL_MIN_SCORE) so this
// site, articles-for-topics.service.ts, and news-cluster.service.ts stay in
// lockstep.
export const VECTOR_SEARCH_DATA_RETRIEVAL_MIN_SCORE =
  VECTOR_RETRIEVAL_MIN_SCORE;
export const VECTOR_SEARCH_DATA_RETRIEVAL_RESULT_LIMIT = 500;
export const VECTOR_SEARCH_DATA_RETRIEVAL_NUM_CANDIDATES = 1000;

// --- Vector Search: Topic Linking ---
export const TOPIC_LINKING_LIMIT = 100;
export const TOPIC_LINKING_NUM_CANDIDATES = 1000;

// --- Mera Protocol User Topics ---
export const PROTOCOL_TOPIC_SEMANTIC_SEARCH_NUM_CANDIDATES = 100;
export const TOPIC_SEMANTIC_MATCH_MIN_SCORE = 0.95;
