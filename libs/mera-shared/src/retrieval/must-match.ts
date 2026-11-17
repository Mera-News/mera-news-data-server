/**
 * Must-match: a followed story's names (e.g. ["Web Summit", "WebSummit"]), any
 * one of which an article has to contain. Names are stored on the anonymous
 * `UserTopic` row and applied only to strict (followed-story) requests, on the
 * warm and cold seams. Vector cosine cannot tell one "Summit 2026" from
 * another; the named entity can.
 *
 * mera-app keeps an identical copy of `normalizeMustMatch`
 * (`lib/news-harness/core/must-match.ts`); change both together.
 */

/** The searchable text of one article. */
export interface ArticleMatchText {
  titleEn?: string | null;
  descriptionEn?: string | null;
  /** Original-language title, so native-language mentions still match. */
  titleOriginal?: string | null;
}

/**
 * The lowercased searchable text of one article. The fields are joined with a
 * U+0001 control character on purpose: it never occurs in article text, so a
 * multi-word name cannot match by straddling the title/description join.
 * Do not "tidy" it to whitespace.
 */
export function buildHaystack(text: ArticleMatchText): string {
  return [text.titleEn, text.descriptionEn, text.titleOriginal]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join('\u0001')
    .toLowerCase();
}

const MIN_NAME_LENGTH = 3;
const MAX_NAME_LENGTH = 60;
const MAX_NAMES = 3;

/**
 * NFC, trim, drop entries under 3 or over 60 chars, dedupe case-insensitively
 * keeping the first, keep at most 3. An empty result means "no names".
 * Runs at the service boundary: no ValidationPipe reaches nested inputs.
 */
export function normalizeMustMatch(raw?: readonly string[] | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw ?? []) {
    if (out.length === MAX_NAMES) break;
    const name = entry.normalize('NFC').trim();
    if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH)
      continue;
    const folded = name.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(name);
  }
  return out;
}

/** Whitespace, any Unicode dash, and U+2212 MINUS SIGN. */
const SEPARATOR_RUN = /[\s\p{Pd}−]+/u;

function namePattern(name: string): RegExp {
  const parts = name
    .normalize('NFC')
    .split(SEPARATOR_RUN)
    .filter((p) => p.length > 0)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (parts.length === 0) return /(?!)/; // a name of only dashes matches nothing
  // Separators are optional and interchangeable: "Russia-Africa" matches
  // "Russia–Africa" and "Russia – Africa", "Web Summit" matches "WebSummit".
  const body = parts.join('[\\s\\p{Pd}\\u2212]*');
  // No letter or digit may touch the match, so "Web Summit" misses "Cobweb Summit".
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
}

export interface MustMatchOutcome<T> {
  kept: T[];
  /** The names the filter applied, for the caller's log line. */
  names: string[];
  removed: number;
}

/**
 * Keep the items whose haystack contains any name. Fails CLOSED: an item with no text is dropped, because the caller asked
 * for exactly this story and an unreadable row cannot be shown to be it.
 */
export function filterByMustMatch<T>(
  names: string[],
  items: T[],
  getText: (item: T) => ArticleMatchText,
): MustMatchOutcome<T> {
  const patterns = names.map(namePattern);
  const kept = items.filter((item) => {
    const haystack = buildHaystack(getText(item)).normalize('NFC');
    return haystack.trim().length > 0 && patterns.some((p) => p.test(haystack));
  });
  return { kept, names, removed: items.length - kept.length };
}

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

function wordsOf(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .split(WORD_SPLIT)
    .filter((w) => w.length > 0);
}

/**
 * Keep only the names every word of which the topic text itself contains. The
 * generator invents entities a broad story never uses ("Amsterdam UMC" for
 * "Amsterdam child falls window hospital", "ProRail" for a rail-sabotage
 * topic), and a filter on one empties the follow. An empty result is a broad
 * story: no filter.
 */
export function groundNamesInText(
  names: readonly string[],
  topicText: string,
): string[] {
  const topicWords = new Set(wordsOf(topicText));
  return names.filter((name) => {
    const words = wordsOf(name);
    return words.length > 0 && words.every((w) => topicWords.has(w));
  });
}
