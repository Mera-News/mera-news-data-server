/**
 * Canonical category topics: the Google NLP tree as anonymous `UserTopic` rows
 * (`is_canonical: true`) that ingest links articles to, for the World page's
 * topic filter. Pure; the seed command builds the rows, the embed stage
 * classifies with them.
 *
 * Measured in apps/mera-scripts/eval-data/category-tree (README there). Only L1
 * shipped: centroid node vectors scored against the article's `text-matching`
 * vector, flat argmax over the roots, a link only when the winner clears the
 * gate (about 72% precision at about 48% coverage on the held-out half). The
 * constants below are that run's `chosen.json`; the spec pins them, so a new
 * calibration changes both in one commit.
 */
import { NLP_CATEGORY_NODES } from './nlp-category-tree';

/** `news_topic_text` = prefix + path, so a canonical row can never share text with a device topic. */
export const CANONICAL_TOPIC_TEXT_PREFIX = 'cat:';

export const CATEGORY_TREE_EXCLUDED_ROOTS: readonly string[] = [
  '/Adult',
  '/Online Communities',
];

/** Tree levels that have canonical rows. */
export const CANONICAL_TOPIC_LEVELS: readonly number[] = [1];

/** A link needs `top >= floor` and `top - runnerUp >= margin` (cosine). */
export const CANONICAL_L1_GATE = { margin: 0.0125, floor: 0.66 } as const;

export interface CanonicalIndexEntry {
  topicId: string;
  /** The row's `canonical_embed`: a `text-matching` centroid, unit length. */
  vector: readonly number[];
}

export interface CanonicalLink {
  topicId: string;
  /** Cosine between the article and the topic. */
  confidence: number;
}

export const canonicalTopicText = (path: string): string =>
  CANONICAL_TOPIC_TEXT_PREFIX + path;

export const categoryLabel = (path: string): string =>
  path.slice(path.lastIndexOf('/') + 1);

export const categoryLevel = (path: string): number =>
  path.split('/').length - 1;

export const categoryParent = (path: string): string | null =>
  categoryLevel(path) > 1 ? path.slice(0, path.lastIndexOf('/')) : null;

/** The text embedded per node (`text-matching`) before centroids are taken. */
export const categoryLabelText = (path: string): string =>
  `News article about ${categoryLabel(path)}`;

/** Every tree node outside the excluded subtrees. */
export function categoryTreeNodes(
  nodes: readonly string[] = NLP_CATEGORY_NODES,
): string[] {
  return nodes.filter(
    (p) =>
      !CATEGORY_TREE_EXCLUDED_ROOTS.some(
        (r) => p === r || p.startsWith(r + '/'),
      ),
  );
}

/**
 * Normalized mean of the label vectors of `path` and every descendant: what a
 * canonical row stores as `canonical_embed`.
 */
export function categoryCentroid(
  path: string,
  nodes: readonly string[],
  vectorOf: (node: string) => readonly number[],
): number[] {
  const members = nodes.filter((q) => q === path || q.startsWith(path + '/'));
  if (members.length === 0) throw new Error(`no tree node for ${path}`);
  const sum = new Array<number>(vectorOf(members[0]).length).fill(0);
  for (const q of members) vectorOf(q).forEach((x, i) => (sum[i] += x));
  const norm = Math.hypot(...sum);
  return sum.map((x) => x / norm);
}

/**
 * The confident L1 link for one article's `text-matching` vector, or none.
 * Never throws on an empty index: no canonical rows means no links.
 */
export function classifyCanonical(
  vector: readonly number[],
  index: readonly CanonicalIndexEntry[],
): CanonicalLink[] {
  let best: CanonicalIndexEntry | null = null;
  let top = -Infinity;
  let runnerUp = -Infinity;
  for (const entry of index) {
    let s = 0;
    for (let i = 0; i < vector.length; i++) s += vector[i] * entry.vector[i];
    if (s > top) {
      runnerUp = top;
      top = s;
      best = entry;
    } else if (s > runnerUp) {
      runnerUp = s;
    }
  }
  if (
    !best ||
    top < CANONICAL_L1_GATE.floor ||
    top - runnerUp < CANONICAL_L1_GATE.margin
  ) {
    return [];
  }
  return [{ topicId: best.topicId, confidence: top }];
}
