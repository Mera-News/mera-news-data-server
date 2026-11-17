import chosen from '../../../../../mera-scripts/eval-data/story-key-calibration/chosen.json';
import {
  enTextChars,
  HAMMING_BAR,
  MIN_TEXT_CHARS,
  NEAR_DUP_EXCLUSION,
  NEAR_DUP_WINDOW_S,
} from './story-key.config';

/**
 * The near-copy rule is the committed calibration, never a literal typed here.
 * The index spec drives the service at exactly HAMMING_BAR and HAMMING_BAR + 1.
 */
describe('story-key config', () => {
  it('takes the bar, window, exclusion mode and English minimum from chosen.json', () => {
    expect(HAMMING_BAR).toBe(chosen.hammingBar);
    expect(MIN_TEXT_CHARS).toBe(chosen.minTextChars);
    expect(NEAR_DUP_WINDOW_S).toBe(chosen.windowS);
    expect(NEAR_DUP_EXCLUSION).toBe(chosen.exclusion);
  });

  it('is a usable precision gate', () => {
    expect(Number.isInteger(HAMMING_BAR)).toBe(true);
    expect(HAMMING_BAR).toBeGreaterThanOrEqual(0);
    expect(HAMMING_BAR).toBeLessThan(768);
    expect(NEAR_DUP_WINDOW_S).toBeGreaterThan(0);
    expect(['publisher', 'source']).toContain(chosen.exclusion);
    expect(Number.isInteger(MIN_TEXT_CHARS)).toBe(true);
    expect(MIN_TEXT_CHARS).toBeGreaterThanOrEqual(0);
  });

  // Layer 2 shipped on after the owner signed off the 50-pair spot check (README,
  // "Owner spot check"); a change flips this pin and chosen.json together.
  it('pins the shipped rule (bar 32, 24h, same-source excluded, 120 English chars)', () => {
    expect(chosen).toEqual({
      hammingBar: 32,
      windowS: 86400,
      exclusion: 'source',
      minTextChars: 120,
      provisional: false,
    });
  });

  it('counts English title plus description in UTF-16 units, as the calibration did', () => {
    expect(enTextChars('Guest of Freedom', '')).toBe(16);
    expect(enTextChars('ab', undefined)).toBe(2);
    expect(enTextChars(null, 'é😀')).toBe(3);
  });
});
