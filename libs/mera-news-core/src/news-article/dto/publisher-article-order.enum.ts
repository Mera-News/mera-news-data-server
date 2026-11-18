import { registerEnumType } from '@nestjs/graphql';

/** Ordering for `articlesForPublisher`. */
export enum PublisherArticleOrder {
  /** The original view: last 24h, ranked by largest cluster size. */
  TOP_HEADLINES = 'TOP_HEADLINES',
  /** Newest first across all of the publisher's feeds, 48h, deduped by URL. */
  NEWEST = 'NEWEST',
}

registerEnumType(PublisherArticleOrder, {
  name: 'PublisherArticleOrder',
  description: 'Ordering for articlesForPublisher.',
  valuesMap: {
    TOP_HEADLINES: {
      description:
        'Last 24h ranked by largest cluster size (the original behaviour).',
    },
    NEWEST: {
      description:
        'Newest first across all feeds over 48h, deduped by canonical URL, at most 50 per page.',
    },
  },
});
