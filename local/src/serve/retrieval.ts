// Search and topic retrieval over the one-computer store. Deliberately simple:
// nearest articles by vector, a date window, and text match, fused by rank the
// way the full server fuses its two search legs.
import type { Embedder } from '../embed/embedder.ts';
import type { Store } from '../store/store.ts';

/** How nearest articles are found. Measured: sqlite-vec answers 100,000 articles in about 34 ms. */
export const VECTOR_LEG: 'sqlite-vec' | 'scan' = 'sqlite-vec';

/** The full server's search constants. */
export const RRF_K = 60;
export const LEXICAL_WEIGHT = 1.0;
export const SEMANTIC_WEIGHT = 0.9;
export const MAX_SEARCH_LIMIT = 25;
export const DEFAULT_SEARCH_LIMIT = 20;
const OVERFETCH = 4;

/** Picks cover this many hours, counted back from the last ingest. */
export const PERSONA_WINDOW_HOURS = 48;

export interface SearchHit {
  id: string;
  title: string;
  articleUrl: string;
  publicationName: string;
  pubDate: string;
  languageCode: string | null;
  countryCode: string | null;
  imageUrl: string | null;
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  empty: 'no_articles_yet' | 'no_match' | null;
}

const queryCache = new Map<string, Float32Array>();

/** Query vectors are kept in memory only; nothing a person asks for is written to the file. */
export async function embedQueryCached(embedder: Embedder, text: string): Promise<Float32Array> {
  const key = `${embedder.model}\u0000${text}`;
  const hit = queryCache.get(key);
  if (hit) return hit;
  const vector = await embedder.embedQuery(text);
  if (queryCache.size >= 1000) queryCache.delete(queryCache.keys().next().value!);
  queryCache.set(key, vector);
  return vector;
}

function nearest(store: Store, vector: Float32Array, k: number, since?: string) {
  return VECTOR_LEG === 'sqlite-vec' ? store.nearest(vector, k, since) : store.scanNearest(vector, k, since);
}

/** Article ids whose headline or description contains the text, best first. */
function textMatch(store: Store, query: string, limit: number): string[] {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  // Trigrams match only three characters or more; a shorter word needs a scan.
  if (words.some((w) => [...w].length < 3)) {
    const like = words.map(() => '(title LIKE ? OR description LIKE ?)').join(' AND ');
    const args = words.flatMap((w) => [`%${w}%`, `%${w}%`]);
    return (store.db.prepare(`SELECT id FROM articles WHERE ${like} ORDER BY pub_date DESC, id LIMIT ?`).all(...args, limit) as { id: string }[]).map((r) => r.id);
  }
  // Each word as a quoted phrase, so the text is never read as FTS5 syntax.
  const match = words.map((w) => `"${w.replaceAll('"', '""')}"`).join(' ');
  return (
    store.db
      .prepare('SELECT a.id FROM articles_fts f JOIN articles a ON a.rowid = f.rowid WHERE articles_fts MATCH ? ORDER BY bm25(articles_fts), a.id LIMIT ?')
      .all(match, limit) as { id: string }[]
  ).map((r) => r.id);
}

/** The full server's fusion: sum of weight / (k + rank) per leg, ties broken by id. */
export function fuseByRank(legs: { ids: string[]; weight: number }[], k = RRF_K): { id: string; score: number }[] {
  const acc = new Map<string, number>();
  for (const leg of legs) leg.ids.forEach((id, index) => acc.set(id, (acc.get(id) ?? 0) + leg.weight / (k + index + 1)));
  return [...acc.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id, score]) => ({ id, score }));
}

interface ArticleRow {
  id: string;
  title: string;
  article_url: string;
  pub_date: string;
  language_code: string | null;
  image_url: string | null;
  story_key: string;
  publication_name: string;
  country_code: string | null;
}

export function articleRows(store: Store, ids: string[]): Map<string, ArticleRow> {
  const get = store.db.prepare(
    // As the full server answers: the article's detected language, else the feed's declared one.
    `SELECT a.id, a.title, a.article_url, a.pub_date, COALESCE(a.language_code, f.feed_language_code) AS language_code,
       a.image_url, a.story_key, f.publication_name, f.feed_url, f.country_code
     FROM articles a JOIN feeds f ON f.id = a.feed_id WHERE a.id = ?`,
  );
  const rows = new Map<string, ArticleRow>();
  for (const id of ids) {
    const row = get.get(id) as (ArticleRow & { feed_url: string }) | undefined;
    if (row) rows.set(id, { ...row, publication_name: row.publication_name || new URL(row.feed_url).hostname });
  }
  return rows;
}

/**
 * Text and meaning together, over everything stored (no time limit). Copies of one article
 * show once. An empty answer says whether the file is empty or nothing matched.
 */
export async function searchArticles(store: Store, embedder: Embedder, query: string, opts: { limit: number }): Promise<SearchResult> {
  if (store.articleCount() === 0) return { hits: [], empty: 'no_articles_yet' };
  const limit = Math.min(Math.max(opts.limit, 1), MAX_SEARCH_LIMIT);
  const text = query.trim();
  if (!text) return { hits: [], empty: 'no_match' };
  const pool = limit * OVERFETCH;
  const lexical = textMatch(store, text, pool);
  const semantic = nearest(store, await embedQueryCached(embedder, text), pool).map((h) => h.id);
  const fused = fuseByRank([
    { ids: lexical, weight: LEXICAL_WEIGHT },
    { ids: semantic, weight: SEMANTIC_WEIGHT },
  ]);
  const rows = articleRows(store, fused.map((f) => f.id));
  const seenStories = new Set<string>();
  const hits: SearchHit[] = [];
  for (const { id, score } of fused) {
    const row = rows.get(id);
    if (!row || seenStories.has(row.story_key)) continue;
    seenStories.add(row.story_key);
    hits.push({
      id,
      title: row.title,
      articleUrl: row.article_url,
      publicationName: row.publication_name,
      pubDate: row.pub_date,
      languageCode: row.language_code,
      countryCode: row.country_code,
      imageUrl: row.image_url,
      score,
    });
    if (hits.length === limit) break;
  }
  return { hits, empty: hits.length === 0 ? 'no_match' : null };
}

/** The start of the picks window: PERSONA_WINDOW_HOURS before the last ingest, or null before the first one. */
export function personaWindowStart(store: Store, hours = PERSONA_WINDOW_HOURS): string | null {
  const last = store.lastIngestAt();
  return last ? new Date(Date.parse(last) - hours * 3600_000).toISOString() : null;
}

/** The nearest articles to one topic inside the picks window, nearest first. */
export async function topicArticles(
  store: Store,
  embedder: Embedder,
  topic: string,
  opts: { limit: number; since: string | null },
): Promise<{ id: string; storyKey: string }[]> {
  if (!opts.since || opts.limit <= 0) return [];
  const hits = nearest(store, await embedQueryCached(embedder, topic), opts.limit, opts.since);
  const rows = articleRows(store, hits.map((h) => h.id));
  return hits.flatMap((h) => {
    const row = rows.get(h.id);
    return row ? [{ id: h.id, storyKey: row.story_key }] : [];
  });
}
