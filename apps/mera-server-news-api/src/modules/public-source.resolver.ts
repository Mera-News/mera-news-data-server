import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { PublicationSource } from '@mera/models/models/publication-source.model';

/** Origin plus path: no userinfo, query string or fragment. Empty when it is not a web URL. */
function stripUrlSecrets(value: string): string {
  try {
    const url = new URL(value);
    return url.origin === 'null' ? '' : url.origin + url.pathname;
  } catch {
    return '';
  }
}

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
