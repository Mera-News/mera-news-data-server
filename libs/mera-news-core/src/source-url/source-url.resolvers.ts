import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { NewsArticle } from '@mera/models/models/news-article.model';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import {
  redactAddress,
  stripUrlSecrets,
} from '@mera/shared/url/strip-url-secrets';

/**
 * Anyone who holds a key to this API, or reaches it in open mode, can read
 * source fields, and a feed URL can carry a token (a `key=` query value or
 * userinfo). So this API always serves the URLs without them and never the
 * last fetch error. This type is returned by every source-bearing field, so
 * one resolver covers them all.
 */
@Resolver(() => PublicationSource)
export class PublicSourceResolver {
  @ResolveField(() => String, { name: 'feed_url' })
  feedUrl(@Parent() source: PublicationSource): string {
    return stripUrlSecrets(source.feed_url);
  }

  @ResolveField(() => String, { name: 'publication_url', nullable: true })
  publicationUrl(@Parent() source: PublicationSource): string | null {
    if (!source.publication_url) return null;
    return stripUrlSecrets(source.publication_url) || null;
  }

  @ResolveField(() => String, { name: 'last_fetch_error', nullable: true })
  lastFetchError(): null {
    return null;
  }
}

/** Articles stored before addresses were stripped on write still hold the full feed address. */
@Resolver(() => NewsArticle)
export class ArticleSourceUriResolver {
  @ResolveField(() => String, { name: 'source_uri' })
  sourceUri(@Parent() article: NewsArticle): string {
    return redactAddress(article.source_uri);
  }
}
