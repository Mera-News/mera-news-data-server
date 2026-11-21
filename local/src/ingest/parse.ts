// Feed bytes to items, as the full server reads them: the same parser and
// options, the same charset choice, the same text clean-up and image choice.
import Parser from 'rss-parser';
import { sanitizeText } from './shared.ts';

type MediaCandidate = { url?: string; width?: string; $?: { url?: string; width?: string } };

interface RawItem {
  title?: string;
  link?: string;
  pubDate?: string;
  description?: string;
  contentSnippet?: string;
  enclosure?: { url?: string };
  mediaContent?: string | MediaCandidate | MediaCandidate[];
  mediaThumbnail?: string | MediaCandidate | MediaCandidate[];
}

export interface FeedItem {
  title: string;
  description: string;
  link: string;
  pubDate: string | null;
  imageUrl: string | null;
}

export interface ParsedFeed {
  /** The feed's own title, if it has one. */
  title: string | null;
  /** The feed's declared language, if it has one. */
  language: string | null;
  items: FeedItem[];
  /** Items without a title or a link, which are left out. */
  skipped: number;
}

export class FeedParseError extends Error {
  readonly code: 'not_rss' | 'empty_feed';
  constructor(code: 'not_rss' | 'empty_feed', message: string) {
    super(message);
    this.name = 'FeedParseError';
    this.code = code;
  }
}

const parser = new Parser<Record<string, unknown>, RawItem>({
  customFields: {
    item: [
      ['dc:creator', 'creator'],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['media:content', 'mediaContent', { keepArray: true }],
    ],
  },
});

const ALIASES: Record<string, string> = {
  'latin-1': 'iso-8859-1',
  latin1: 'iso-8859-1',
  cp1252: 'windows-1252',
  ascii: 'utf-8',
  'us-ascii': 'utf-8',
};

/** The charset from the Content-Type header, else the XML prolog, else UTF-8. */
export function decodeFeed(bytes: Uint8Array, contentType: string | null): string {
  let encoding =
    contentType?.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] ??
    new TextDecoder('latin1').decode(bytes.subarray(0, 200)).match(/<\?xml[^>]+encoding\s*=\s*["']([^"']+)["']/i)?.[1] ??
    'utf-8';
  encoding = encoding.toLowerCase();
  try {
    return new TextDecoder(ALIASES[encoding] ?? encoding).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function widestMedia(candidate: RawItem['mediaContent']): string | undefined {
  if (!candidate) return undefined;
  let bestUrl: string | undefined;
  let bestWidth = -1;
  for (const c of Array.isArray(candidate) ? candidate : [candidate]) {
    const url = typeof c === 'string' ? c : c.url || c.$?.url;
    if (!url) continue;
    const raw = typeof c === 'string' ? undefined : (c.width ?? c.$?.width);
    const width = raw ? parseInt(raw, 10) : 0;
    const effective = Number.isNaN(width) ? 0 : width;
    if (bestUrl === undefined || effective > bestWidth) {
      bestUrl = url;
      bestWidth = effective;
    }
  }
  return bestUrl;
}

export async function parseFeed(bytes: Uint8Array, contentType: string | null): Promise<ParsedFeed> {
  let feed: Awaited<ReturnType<typeof parser.parseString>>;
  try {
    feed = await parser.parseString(decodeFeed(bytes, contentType));
  } catch (error) {
    throw new FeedParseError('not_rss', `Not an RSS or Atom feed: ${(error as Error).message.split('\n')[0]}`);
  }
  if (!feed?.items?.length) throw new FeedParseError('empty_feed', 'The feed has no items.');
  const items: FeedItem[] = [];
  let skipped = 0;
  for (const item of feed.items) {
    const title = sanitizeText(item.title);
    const link = item.link?.trim();
    if (!title || !link) {
      skipped++;
      continue;
    }
    items.push({
      title,
      description: sanitizeText(item.contentSnippet || item.description || item.title || ''),
      link,
      pubDate: item.pubDate ?? null,
      imageUrl: widestMedia(item.mediaContent) ?? item.enclosure?.url ?? widestMedia(item.mediaThumbnail) ?? null,
    });
  }
  return { title: sanitizeText(feed.title) || null, language: (feed as { language?: string }).language?.trim() || null, items, skipped };
}
