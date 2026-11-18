import { registerEnumType } from '@nestjs/graphql';
import type { RelatedSortMode as SortMode } from '@mera/shared';

/**
 * How the reader has asked the related-articles list to be ordered. Mirrors the
 * app's persisted `related_articles_sort` setting, which is ONE setting shared
 * by both detail routes.
 */
export enum RelatedSortModeEnum {
  RELEVANCE = 'RELEVANCE',
  OLDEST = 'OLDEST',
  NEWEST = 'NEWEST',
}

registerEnumType(RelatedSortModeEnum, {
  name: 'RelatedSortMode',
  description:
    "Ordering for relatedArticlesPage. RELEVANCE ranks the reader's publications and language; the two date modes are flat.",
  valuesMap: {
    RELEVANCE: {
      description:
        'Default. Subscribed publications, then preferred publications, then the reader app language, then newest first. Country is not a key. The only mode that consults the reader context.',
    },
    OLDEST: {
      description: 'Flat publish-date ascending. Undated rows sort last.',
    },
    NEWEST: {
      description:
        'Flat publish-date descending. Undated rows sort last here too, so NEWEST is not the exact reverse of OLDEST.',
    },
  },
});

/**
 * GraphQL enum -> the shared sort's own string union. Kept as an explicit map,
 * not a `toLowerCase()`, so adding a mode to one side without the other is a
 * compile error rather than a silent fallback to 'relevance'.
 */
const TO_SORT_MODE: Record<RelatedSortModeEnum, SortMode> = {
  [RelatedSortModeEnum.RELEVANCE]: 'relevance',
  [RelatedSortModeEnum.OLDEST]: 'oldest',
  [RelatedSortModeEnum.NEWEST]: 'newest',
};

export function toSortMode(mode?: RelatedSortModeEnum | null): SortMode {
  return mode ? TO_SORT_MODE[mode] : 'relevance';
}
