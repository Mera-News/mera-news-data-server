import { ConfigService } from '@nestjs/config';
import { Args, Int, Query, Resolver } from '@nestjs/graphql';
import { Throttle } from '@nestjs/throttler';
import { GraphQLError } from 'graphql';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  NewsSearchHit,
  NewsSearchService,
} from '@mera/news-core';
import { newsApiOpen } from '../open-mode';

@Resolver()
export class NewsSearchResolver {
  constructor(
    private readonly newsSearchService: NewsSearchService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Offered to key holders only. A cache miss spends an embedding call, and in
   * open mode there is one shared principal and no key to bound it by, so open
   * mode answers SEARCH_NOT_OFFERED whatever else is configured.
   */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Query(() => [NewsSearchHit], {
    name: 'searchNews',
    description:
      'Hybrid text + semantic search over the last 48h of articles. ' +
      'Headline-only results, hydrate ids via articlesForTopicsByIds. ' +
      `Capped at ${MAX_SEARCH_LIMIT} results.`,
  })
  async searchNews(
    @Args('query', { type: () => String }) query: string,
    @Args('limit', {
      type: () => Int,
      nullable: true,
      description: `Max results, clamped to ${MAX_SEARCH_LIMIT}.`,
    })
    limit: number | null,
  ): Promise<NewsSearchHit[]> {
    // Open mode is configuration, read the one way every part of this API reads
    // it, so a wrapped or custom verifier cannot change who is offered search.
    if (newsApiOpen(this.config)) {
      throw new GraphQLError('Search is offered to API key holders only.', {
        extensions: { code: 'SEARCH_NOT_OFFERED' },
      });
    }
    const size = Math.min(
      Math.max(limit ?? DEFAULT_SEARCH_LIMIT, 1),
      MAX_SEARCH_LIMIT,
    );
    return this.newsSearchService.searchNews(query, size);
  }
}
