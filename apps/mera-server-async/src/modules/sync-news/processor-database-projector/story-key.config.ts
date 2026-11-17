/**
 * Story-key tunables. The near-copy rule comes from the committed calibration
 * (`eval-data/story-key-calibration/chosen.json`), never from a literal here:
 * the bar is a precision gate, and a wrong merge copies a model score AND its
 * note onto an unrelated article on the phone (the app's grounding check is one
 * shared token, so it does not guard this). Do not loosen it for display.
 */
import chosen from '../../../../../mera-scripts/eval-data/story-key-calibration/chosen.json';

/**
 * Max Hamming distance (of 768) between text-matching sign bits for a near
 * copy. 0 or below turns layer 2 off entirely (not "d = 0 only").
 */
export const HAMMING_BAR: number = chosen.hammingBar;

/**
 * Layer 2 takes part only when `title_en_internal_only.length +
 * description_en_internal_only.length` (UTF-16 units, as the calibration
 * counted) reaches this, as query and as seed. Short template titles
 * ("Songs and Speeches") are bit-identical across unrelated publishers.
 */
export const MIN_TEXT_CHARS: number = chosen.minTextChars;

/** The English length the layer-2 gate compares against MIN_TEXT_CHARS. */
export const enTextChars = (
  titleEn?: string | null,
  descriptionEn?: string | null,
) => (titleEn ?? '').length + (descriptionEn ?? '').length;

/** A near copy must be ingested within this many seconds of its seed. */
export const NEAR_DUP_WINDOW_S: number = chosen.windowS;

/**
 * Pairs that never near-join: same publisher (`publisher`) or same feed
 * (`source`). Same-publisher templates (obituaries, dated bulletins) sit at
 * d 0-45, and layer 1 already joins a publisher's own reposts.
 */
export const NEAR_DUP_EXCLUSION: 'publisher' | 'source' =
  chosen.exclusion === 'source' ? 'source' : 'publisher';

/** Ring slots: the 48h prod peak (~550k) plus ~45%. A wrap only under-merges. */
export const RING_CAPACITY = 800_000;

/** How long an article stays joinable (the article retention window). */
export const STORY_WINDOW_S = 48 * 3600;

/** Bytes of `packSignBits` over a 768-dim vector. */
export const TM_BITS_BYTES = 96;
