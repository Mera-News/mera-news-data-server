import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';
import type { UserGeoLanguageContext } from '@mera/shared';
import { CursorPageInfo } from '../../dto/pagination.dto';
import { ArticleSummary } from './articles-for-topics.dto';

/**
 * The reader's geo/language signals, needed to order the RELEVANCE mode.
 *
 * ANONYMOUS AND EPHEMERAL BY CONSTRUCTION. `relatedArticlesPage` takes no
 * `@CurrentUser`, writes no collection, and this input is deliberately NOT part
 * of any cache key — the ordered-key cache is keyed on the cluster alone, so
 * every reader of a story shares one entry and nothing preference-shaped is ever
 * written to Redis. It exists only to order one response.
 *
 * Every field is optional. Absent degrades to the sort's documented fail-open
 * behaviour: no publication tiers and no language preference, so newest first.
 * Only `appLanguageBase` and the two publication lists order the list today;
 * the country fields are still accepted for older and newer clients alike.
 */
@InputType({
  description:
    'Anonymous, ephemeral reader signals used to order the RELEVANCE mode. Never persisted, never cached, never linked to a user.',
})
export class RelatedArticlesContextInput {
  @Field(() => String, {
    nullable: true,
    description: 'Home country, ISO alpha-3.',
  })
  homeCountryAlpha3?: string | null;

  @Field(() => [String], {
    nullable: true,
    description:
      "The reader's other countries, ISO alpha-3, ranked weight-desc.",
  })
  otherCountriesAlpha3?: string[];

  @Field(() => String, {
    nullable: true,
    description: 'App-UI language BASE tag (`zh`, not `zh-Hans`).',
  })
  appLanguageBase?: string | null;

  @Field(() => [String], {
    nullable: true,
    description:
      'Publications the reader explicitly prefers, normalized names.',
  })
  preferredPublications?: string[];

  @Field(() => [String], {
    nullable: true,
    description:
      'Countries whose sources the reader explicitly prefers, ISO alpha-3.',
  })
  preferredCountriesAlpha3?: string[];

  @Field(() => [String], {
    nullable: true,
    description:
      'Publications the reader subscribes to, normalized names. Ranked above preferredPublications.',
  })
  subscribedPublications?: string[];
}

/**
 * Build the shared sort's context from the wire input. Returns `null` for an
 * absent input so the sort takes its fail-open path rather than seeing an object
 * of nulls, and normalizes the preference lists into the Sets it expects.
 */
export function toGeoLanguageContext(
  input?: RelatedArticlesContextInput | null,
): UserGeoLanguageContext | null {
  if (!input) return null;
  return {
    homeCountryAlpha3: input.homeCountryAlpha3 ?? null,
    otherCountriesAlpha3: input.otherCountriesAlpha3 ?? [],
    appLanguageBase: input.appLanguageBase ?? null,
    preferredPublications: new Set(input.preferredPublications ?? []),
    preferredCountriesAlpha3: new Set(input.preferredCountriesAlpha3 ?? []),
    subscribedPublications: new Set(input.subscribedPublications ?? []),
  };
}

@ObjectType({
  description: 'One chip for the related-coverage filters, with its row count.',
})
export class RelatedFacetCount {
  @Field(() => String, {
    description:
      'Country as ISO alpha-3 (or GLOBAL for international sources), or a base language tag.',
  })
  code!: string;

  @Field(() => Int)
  count!: number;
}

/**
 * The chips a client can render for this story's coverage, computed over the
 * whole candidate set (after `excludeIds`, before paging), so they cost no
 * extra round trip. Each dimension is counted with the OTHER dimension's filter
 * applied and its own ignored.
 */
@ObjectType({
  description:
    'Country and language counts over the related set. Each dimension is counted with the filter of the other dimension applied.',
})
export class RelatedArticleFacets {
  @Field(() => [RelatedFacetCount])
  countries!: RelatedFacetCount[];

  @Field(() => [RelatedFacetCount])
  languages!: RelatedFacetCount[];
}

@ObjectType({
  description:
    'One page of sibling coverage for an article, already ordered server-side.',
})
export class RelatedArticlesPage {
  @Field(() => [ArticleSummary])
  articles!: ArticleSummary[];

  @Field(() => CursorPageInfo)
  pageInfo!: CursorPageInfo;

  /**
   * The supplied `after` cursor no longer resolves, so this page restarts at
   * the top of the list. Happens when the cached ordered list expired or the
   * story was re-clustered mid-scroll.
   *
   * The client MUST replace its accumulated list rather than append to it —
   * appending would stack a second copy of page 1 under the pages already on
   * screen. There is no way for the client to infer this from the rows alone.
   */
  @Field(() => Boolean, {
    description:
      'The `after` cursor did not resolve and this page restarts at index 0. Clients must REPLACE their list, not append.',
  })
  restarted!: boolean;

  /**
   * Chip counts for the country and language filters. Same on every page of
   * one filtered list, so a client can read them off the first page.
   */
  @Field(() => RelatedArticleFacets, {
    description:
      'Country and language chip counts over the whole related set, not just this page.',
  })
  facets!: RelatedArticleFacets;

  // Deliberately no `totalCount`: `hasNextPage` already drives the stop logic,
  // and a rendered total is the one number the MAX_RELATED_KEYS backstop could
  // make disagree with the list it labels.
}
