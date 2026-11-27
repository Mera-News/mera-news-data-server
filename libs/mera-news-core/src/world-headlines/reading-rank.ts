import { Types } from 'mongoose';

/** A report in the reader's language at or above this score is shown first. */
export const READER_LANGUAGE_MIN_SCORE = 50;

/** Added to a qualifying reader-language report, above any plain score (0 to 100). */
const READER_LANGUAGE_TIER = 1000;

export interface EditionCardLike {
  articleId: Types.ObjectId;
  lang?: string | null;
  score?: number | null;
}

export interface EditionEntryLike {
  articleId: Types.ObjectId;
  cards?: readonly EditionCardLike[] | null;
}

const isScored = (score: number | null | undefined): score is number =>
  typeof score === 'number' && Number.isFinite(score);

/**
 * How strongly a report is preferred: its reading score, plus a tier above
 * every score when it is in the reader's language and scores at least
 * READER_LANGUAGE_MIN_SCORE. An unscored report ranks 0 and never counts as a
 * reader-language match.
 */
export function readingRank(
  score: number | null | undefined,
  inReaderLanguage: boolean,
): number {
  if (!isScored(score)) return 0;
  const tier =
    inReaderLanguage && score >= READER_LANGUAGE_MIN_SCORE
      ? READER_LANGUAGE_TIER
      : 0;
  return tier + score;
}

function pick(
  entry: EditionEntryLike,
  language: string,
): { articleId: Types.ObjectId; rank: number } {
  const cards = entry.cards ?? [];
  if (!cards.some((c) => isScored(c.score))) {
    return { articleId: entry.articleId, rank: 0 };
  }
  let best = cards[0];
  let bestRank = readingRank(best.score, best.lang === language);
  for (const card of cards.slice(1)) {
    const rank = readingRank(card.score, card.lang === language);
    // Strictly greater: an equal rank keeps the earlier card (stored in the
    // order the representative is chosen).
    if (rank > bestRank) {
      best = card;
      bestRank = rank;
    }
  }
  return { articleId: best.articleId, rank: bestRank };
}

/**
 * The article to show for one edition entry. The stored `entry.articleId`
 * when there is no language, no card, or no scored card; otherwise the card
 * with the highest `readingRank`, ties to the earlier card.
 */
export function pickEditionCard(
  entry: EditionEntryLike,
  language: string | null | undefined,
): Types.ObjectId {
  return language ? pick(entry, language).articleId : entry.articleId;
}

/**
 * An edition ordered for a reader: every entry shows its picked card, and the
 * entries whose card is a qualifying reader-language report come first. Both
 * tiers keep the edition's order; nothing is sorted by score. Returns the
 * input unchanged when there is no language or no scored card at all.
 */
export function orderEditionForLanguage<T extends EditionEntryLike>(
  entries: T[],
  language: string | null | undefined,
): T[] {
  if (
    !language ||
    !entries.some((e) => e.cards?.some((c) => isScored(c.score)))
  ) {
    return entries;
  }
  const first: T[] = [];
  const rest: T[] = [];
  for (const entry of entries) {
    const { articleId, rank } = pick(entry, language);
    (rank >= READER_LANGUAGE_TIER ? first : rest).push({ ...entry, articleId });
  }
  return [...first, ...rest];
}
