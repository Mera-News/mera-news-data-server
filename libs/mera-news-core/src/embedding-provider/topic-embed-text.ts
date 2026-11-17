/**
 * Canonical embed-input for a user topic. v1 embedded every topic as
 * `News about <text>` (retrieval.query) and the article corpus behaviour was
 * validated against those vectors — so every path that embeds a topic (warm
 * submit, semantic match, cold-path fallback) MUST go through this helper or
 * the same topic gets different vectors depending on which path touched it
 * first (drift T2 in V1_V3_DRIFT_AUDIT.md).
 */
export function topicEmbedText(topicText: string): string {
  return `News about ${topicText}`;
}
