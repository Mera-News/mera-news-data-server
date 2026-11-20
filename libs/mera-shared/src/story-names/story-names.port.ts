/**
 * Port for a followed story's must-match names: the 1-3 names every article
 * about exactly that story must mention, derived from the anonymous topic text
 * alone. graphql binds the Gemini adapter; news-api binds
 * `UnconfiguredStoryNamesGenerator`, so it keeps whatever names are
 * already stored and never generates.
 */
export const STORY_NAMES_GENERATOR = 'STORY_NAMES_GENERATOR';

/**
 * Bump when the prompt changes in a way that should regenerate stored names.
 * It is stored on `UserTopic.must_match_version` and is part of the strict
 * classify-cache key, so a bump invalidates both.
 */
export const STORY_NAMES_PROMPT_VERSION = 1;

/**
 * Place-terms prompt version, stored on `UserTopic.place_terms_version` and
 * part of the loose classify-cache key (`aft:pl<v>:`). Bump it only for a
 * prompt change that should regenerate stored place terms.
 */
export const PLACE_TERMS_PROMPT_VERSION = 1;

/**
 * `ok`: normalized names (`[]` = a broad story, no filter).
 * `failed`: the call ran and produced nothing usable (timeout, non-2xx,
 *   unparseable); the caller fails this topic closed for this request.
 * `unconfigured`: no Gemini env; the caller must NOT fail closed, or a missing
 *   env would blank every followed story.
 */
export type StoryNamesOutcome =
  | { status: 'ok'; names: string[] }
  | { status: 'failed'; reason: string }
  | { status: 'unconfigured' };

/**
 * A followed story's gate texts: `{kind, text}` pairs, `[]` when the story
 * has none. Same failed and unconfigured meanings as story names.
 */
export type StoryGatesOutcome =
  | { status: 'ok'; gates: { kind: string; text: string }[] }
  | { status: 'failed'; reason: string }
  | { status: 'unconfigured' };

export interface StoryNamesGenerator {
  /** Never throws. `signal` bounds the whole call. */
  generate(topicText: string, signal?: AbortSignal): Promise<StoryNamesOutcome>;
  /**
   * A LOOSE topic's 0-2 place terms (city, district or state the topic is
   * about, never a country), as `names`. Never throws. Unlike story names,
   * every non-ok outcome is served unfiltered: the place anchor fails open.
   * On this port, not its own, so no app composition root changes.
   */
  generatePlaceTerms(
    topicText: string,
    signal?: AbortSignal,
  ): Promise<StoryNamesOutcome>;
  /**
   * A FOLLOWED story's gate texts, from the topic text alone (for a place
   * gate: the city, region or country the story happens in). Never throws.
   */
  generateStoryGates(
    topicText: string,
    signal?: AbortSignal,
  ): Promise<StoryGatesOutcome>;
}

export class UnconfiguredStoryNamesGenerator implements StoryNamesGenerator {
  generate(): Promise<StoryNamesOutcome> {
    return Promise.resolve({ status: 'unconfigured' });
  }
  generatePlaceTerms(): Promise<StoryNamesOutcome> {
    return Promise.resolve({ status: 'unconfigured' });
  }
  generateStoryGates(): Promise<StoryGatesOutcome> {
    return Promise.resolve({ status: 'unconfigured' });
  }
}
