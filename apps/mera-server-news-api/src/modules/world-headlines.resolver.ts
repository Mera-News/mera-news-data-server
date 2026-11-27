import { BadRequestException } from '@nestjs/common';
import { Args, ID, Int, Query, Resolver } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import {
  DEFAULT_HEADLINE_VIEW_WINDOW_HOURS,
  DEFAULT_PAGE_SIZE,
  HEADLINE_VIEW_WINDOWS_HOURS,
  WorldHeadlinesResponse,
  WorldHeadlinesService,
  parseReaderLanguage,
} from '@mera/news-core';
import { assertOffsetCursor } from './cursor-guard';

const MAX_TOPIC_IDS = 50;
const MAX_PAGE_SIZE = 50;
const MAX_COUNTRY_CODE_LENGTH = 8;
const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/** Names the limit and never the value: a topic filter is the reader's own choice. */
function assertCaps(
  countryCode: string | null | undefined,
  after: string | null | undefined,
  canonicalTopicIds: string[],
): void {
  if (countryCode && countryCode.length > MAX_COUNTRY_CODE_LENGTH) {
    throw new BadRequestException(
      `countryCode exceeds the maximum length of ${MAX_COUNTRY_CODE_LENGTH} characters`,
    );
  }
  if (canonicalTopicIds.length > MAX_TOPIC_IDS) {
    throw new BadRequestException(
      `canonicalTopicIds exceeds the maximum of ${MAX_TOPIC_IDS} ids`,
    );
  }
  if (!canonicalTopicIds.every((id) => OBJECT_ID_HEX.test(id))) {
    throw new BadRequestException(
      'canonicalTopicIds must each be 24 hexadecimal characters',
    );
  }
  assertOffsetCursor(after);
}

@Resolver(() => WorldHeadlinesResponse)
export class WorldHeadlinesResolver {
  constructor(private readonly service: WorldHeadlinesService) {}

  @Query(() => WorldHeadlinesResponse, {
    name: 'worldHeadlines',
    description:
      'Edition headlines for a country (null or "GLOBAL" spans all), optionally filtered to canonical topics (OR, descendants included), with per-topic facets over the unfiltered edition. No edition: the live fallback page (editionBuiltAt null) and no facets, or no headlines when filtered. A filter that cannot apply answers no headlines and unavailableReason.',
  })
  worldHeadlines(
    @Args('countryCode', { type: () => String, nullable: true })
    countryCode?: string,
    @Args('first', {
      type: () => Int,
      nullable: true,
      defaultValue: DEFAULT_PAGE_SIZE,
    })
    first?: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
    @Args('windowHours', {
      type: () => Int,
      nullable: true,
      defaultValue: DEFAULT_HEADLINE_VIEW_WINDOW_HOURS,
    })
    windowHours?: number,
    @Args('canonicalTopicIds', { type: () => [ID], nullable: true })
    canonicalTopicIds?: string[],
    @Args('language', {
      type: () => String,
      nullable: true,
      description:
        "The reader's language as a base language tag, such as en or hi. Each story shows its best-scored report in that language when one scores well enough, otherwise its best-scored report in any language. Stories shown in the reader's language come first, then the rest, each group in the usual order. Absent: the edition's own order and reports.",
    })
    language?: string,
  ): Promise<WorldHeadlinesResponse> {
    assertCaps(countryCode, after, canonicalTopicIds ?? []);
    const readerLanguage = parseReaderLanguage(language);
    const window = windowHours ?? DEFAULT_HEADLINE_VIEW_WINDOW_HOURS;
    if (!(HEADLINE_VIEW_WINDOWS_HOURS as readonly number[]).includes(window)) {
      throw new GraphQLError(
        `windowHours must be one of ${HEADLINE_VIEW_WINDOWS_HOURS.join(', ')}`,
        {
          extensions: { code: 'BAD_WINDOW' },
        },
      );
    }
    // The moved service trusts its page size; this surface does not.
    const pageSize = Math.min(
      Math.max(first ?? DEFAULT_PAGE_SIZE, 1),
      MAX_PAGE_SIZE,
    );
    return this.service.worldHeadlines(
      countryCode,
      pageSize,
      after,
      window,
      canonicalTopicIds ?? [],
      readerLanguage,
    );
  }
}
