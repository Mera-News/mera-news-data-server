import type { Embedder } from '../embed/embedder.ts';
import { normalizePubDate } from '../store/dates.ts';
import { StoreError, type ArticleInput, type FeedRow, type Store } from '../store/store.ts';
import { FetchError, fetchFeed } from './fetch.ts';
import { articleLanguage, createLanguageDetector, feedLanguage, type LanguageDetector } from './language.ts';
import { acquireWriteLock } from './lock.ts';
import { createPacer } from './pacing.ts';
import { FeedParseError, parseFeed } from './parse.ts';
import { articleUrlKey, buildArticleCopyKeys, type AllowList } from './shared.ts';

export const DEFAULT_CONCURRENCY = 4;
export const PER_HOST_GAP_MS = 1000;
export const CONTACT_KEY = 'contact';

export type IngestEvent =
  | { event: 'ingest_start'; run: string; feeds: number }
  | { event: 'feed'; feed: string; status: 'ok' | 'not_modified' | 'failed' | 'refused'; new: number; duplicates: number; error?: string }
  | { event: 'ingest_end'; run: string; feedsOk: number; feedsFailed: number; articlesNew: number };

export interface IngestOptions {
  store: Store;
  /** The news file's path, for the lock beside it. */
  dbPath: string;
  embedder: Embedder;
  detector?: LanguageDetector;
  allowHosts?: AllowList;
  concurrency?: number;
  gapMs?: number;
  timeoutMs?: number;
  /** Only these feeds; default every active one. */
  feedIds?: string[];
  onEvent?: (event: IngestEvent) => void;
}

export interface IngestSummary {
  run: string;
  feedsOk: number;
  feedsFailed: number;
  articlesNew: number;
  failed: { feed: string; reason: string }[];
}

/** What every feed request says about who is fetching, with the person's contact. */
export function userAgentFor(contact: string): string {
  return `mera-news-local (self-hosted; ${contact})`;
}

export function requireContact(store: Store): string {
  const contact = store.getMeta(CONTACT_KEY)?.trim();
  if (!contact) {
    throw new StoreError(
      'contact_missing',
      'Publishers ask to know who reads their feeds, so set an email address or website they can reach you at first.',
      'mera-news-local config set contact you@example.com',
    );
  }
  return contact;
}

const embedText = (title: string, description: string | null) => (description ? `${title}\n${description}` : title);

/**
 * Fetches the chosen feeds once and stores what is new. Embedding happens outside any
 * write; each feed's items, vectors and conditional-request state are then written in one
 * transaction. Safe to run again: known items are skipped, unchanged feeds answer 304.
 */
export async function runIngest(options: IngestOptions): Promise<IngestSummary> {
  const { store, embedder } = options;
  const contact = requireContact(store);
  store.assertEmbeddingModel({ id: embedder.model, dims: embedder.dims });
  const release = acquireWriteLock(options.dbPath);
  try {
    const detector = options.detector ?? (await createLanguageDetector());
    const userAgent = userAgentFor(contact);
    const pace = createPacer(options.concurrency ?? DEFAULT_CONCURRENCY, options.gapMs ?? PER_HOST_GAP_MS);
    const wanted = options.feedIds ? new Set(options.feedIds) : null;
    const feeds = store.listFeeds({ activeOnly: !wanted }).filter((f) => !wanted || wanted.has(f.id));
    const run = store.startRun();
    options.onEvent?.({ event: 'ingest_start', run, feeds: feeds.length });

    const summary: IngestSummary = { run, feedsOk: 0, feedsFailed: 0, articlesNew: 0, failed: [] };
    await Promise.all(
      feeds.map((feed) =>
        pace(new URL(feed.feed_url).host, () => ingestFeed(feed, run)).then((event) => {
          options.onEvent?.(event);
          if (event.status === 'failed' || event.status === 'refused') {
            summary.feedsFailed++;
            summary.failed.push({ feed: feed.feed_url, reason: event.error ?? event.status });
          } else {
            summary.feedsOk++;
            summary.articlesNew += event.new;
          }
        }),
      ),
    );
    store.finishRun(run, summary);
    options.onEvent?.({ event: 'ingest_end', run, feedsOk: summary.feedsOk, feedsFailed: summary.feedsFailed, articlesNew: summary.articlesNew });
    return summary;

    async function ingestFeed(feed: FeedRow, runId: string): Promise<Extract<IngestEvent, { event: 'feed' }>> {
      const at = new Date();
      const base = { event: 'feed' as const, feed: feed.feed_url, new: 0, duplicates: 0 };
      try {
        const answer = await fetchFeed(feed.feed_url, {
          userAgent,
          etag: feed.http_etag,
          lastModified: feed.http_last_modified,
          allowHosts: options.allowHosts,
          timeoutMs: options.timeoutMs,
        });
        if (answer.status === 'not_modified') {
          store.recordFetch(feed.id, { at: at.toISOString(), status: 'not_modified' });
          return { ...base, status: 'not_modified' };
        }
        const parsed = await parseFeed(answer.body, answer.contentType);
        store.fillFeedDetails(feed.id, { title: parsed.title, language: parsed.language });
        const language = feedLanguage(detector, parsed.items, parsed.language ?? feed.feed_language_code);
        const candidates = parsed.items.map((item) => ({ item, fingerprint: articleUrlKey(item.link) }));
        const known = store.knownFingerprints(candidates.map((c) => c.fingerprint));
        const fresh = [...new Map(candidates.filter((c) => !known.has(c.fingerprint)).map((c) => [c.fingerprint, c])).values()];
        const vectors = fresh.length > 0 ? await embedder.embedPassages(fresh.map((c) => embedText(c.item.title, c.item.description))) : [];
        const items: ArticleInput[] = fresh.map((c, i) => ({
          articleUrl: c.item.link,
          fingerprint: c.fingerprint,
          copyKeys: buildArticleCopyKeys(c.item.link),
          title: c.item.title,
          description: c.item.description || null,
          imageUrl: c.item.imageUrl,
          languageCode: articleLanguage(detector, c.item.title, c.item.description, language),
          pubDate: normalizePubDate(c.item.pubDate, at),
          vector: vectors[i]!,
        }));
        const written = store.writeFeedFetch(
          feed.id,
          items,
          { at: at.toISOString(), status: 'ok', etag: answer.etag, lastModified: answer.lastModified },
          runId,
        );
        return { ...base, status: 'ok', new: written.inserted.length, duplicates: written.duplicates + (candidates.length - fresh.length) };
      } catch (error) {
        const refused = error instanceof FetchError && error.code === 'refused';
        const reason =
          error instanceof FetchError || error instanceof FeedParseError ? error.message : `Could not store the feed: ${(error as Error).message}`;
        store.recordFetch(feed.id, { at: at.toISOString(), status: refused ? 'refused' : 'failed', error: reason });
        return { ...base, status: refused ? 'refused' : 'failed', error: reason };
      }
    }
  } finally {
    release();
  }
}
