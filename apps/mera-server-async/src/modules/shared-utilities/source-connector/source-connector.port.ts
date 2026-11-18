import type { PublicationSource } from '@mera/models/models/publication-source.model';
import type { RSSFeedService } from '../rss-feed/rss-feed.service';

// One connector per kind of source. RSS is the only one today; a second kind
// is one adapter and one binding.
export const SOURCE_CONNECTOR = 'SOURCE_CONNECTOR';

export type SourceFetchResult = Awaited<
  ReturnType<RSSFeedService['fetchRSSFeed']>
>;

export interface SourceConnector {
  fetchSource(source: PublicationSource): Promise<SourceFetchResult>;
}

// shortcut: one connector bound for every source type; a map keyed on PublicationSource.type comes with the second connector.
