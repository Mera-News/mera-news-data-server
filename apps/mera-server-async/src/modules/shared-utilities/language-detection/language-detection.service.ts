import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { loadModule, CldFactory, LanguageIdentifier } from 'cld3-asm';

/**
 * Writing scripts we classify text into. `null` (from {@link classifyChar})
 * means the character is not a letter in any script we track (ASCII digit,
 * punctuation, whitespace, emoji, …) and is ignored when computing dominance.
 */
export type Script =
  | 'latin'
  | 'greek'
  | 'cyrillic'
  | 'armenian'
  | 'hebrew'
  | 'arabic'
  | 'devanagari'
  | 'bengali'
  | 'gurmukhi'
  | 'gujarati'
  | 'odia'
  | 'tamil'
  | 'telugu'
  | 'kannada'
  | 'malayalam'
  | 'sinhala'
  | 'thai'
  | 'lao'
  | 'myanmar'
  | 'georgian'
  | 'ethiopic'
  | 'khmer'
  | 'kana'
  | 'cjk'
  | 'hangul';

/**
 * Scripts that map to essentially one language in news content. When one of
 * these dominates the text we RETURN the mapped code directly, overriding
 * whatever CLD3 said — this both fixes CLD3-unsupported scripts (Odia has no
 * CLD3 label at all) and vetoes cross-script misdetections (Kannada text
 * labeled `vi`, Greek labeled `cy`, …). Hebrew uses CLD3's `iw` convention.
 */
const UNIQUE_SCRIPT_LANG: Partial<Record<Script, string>> = {
  odia: 'or',
  tamil: 'ta',
  telugu: 'te',
  kannada: 'kn',
  malayalam: 'ml',
  gujarati: 'gu',
  gurmukhi: 'pa',
  sinhala: 'si',
  thai: 'th',
  lao: 'lo',
  myanmar: 'my',
  georgian: 'ka',
  khmer: 'km',
  greek: 'el',
  hangul: 'ko',
  kana: 'ja',
  ethiopic: 'am',
  armenian: 'hy',
  hebrew: 'iw',
  bengali: 'bn',
};

/**
 * Expected script for a CLD3 language code. Used only for the AMBIGUOUS scripts
 * (devanagari / arabic / cyrillic / cjk) to decide whether CLD3's guess is
 * script-consistent with the text. Any code not listed here is treated as a
 * Latin-script language (CLD3 covers a long Latin tail we don't enumerate).
 */
const LANG_EXPECTED_SCRIPT: Record<string, Script> = {
  // unique-script languages (kept for completeness / defensive consistency)
  or: 'odia',
  ta: 'tamil',
  te: 'telugu',
  kn: 'kannada',
  ml: 'malayalam',
  gu: 'gujarati',
  pa: 'gurmukhi',
  si: 'sinhala',
  th: 'thai',
  lo: 'lao',
  my: 'myanmar',
  ka: 'georgian',
  km: 'khmer',
  el: 'greek',
  ko: 'hangul',
  ja: 'kana',
  am: 'ethiopic',
  hy: 'armenian',
  iw: 'hebrew',
  he: 'hebrew',
  bn: 'bengali',
  // Devanagari family
  hi: 'devanagari',
  mr: 'devanagari',
  ne: 'devanagari',
  sa: 'devanagari',
  kok: 'devanagari',
  mai: 'devanagari',
  bho: 'devanagari',
  // Arabic family
  ar: 'arabic',
  ur: 'arabic',
  fa: 'arabic',
  ps: 'arabic',
  sd: 'arabic',
  ug: 'arabic',
  ckb: 'arabic',
  // Cyrillic family
  ru: 'cyrillic',
  uk: 'cyrillic',
  bg: 'cyrillic',
  mk: 'cyrillic',
  sr: 'cyrillic',
  kk: 'cyrillic',
  ky: 'cyrillic',
  tg: 'cyrillic',
  mn: 'cyrillic',
  be: 'cyrillic',
  // CJK
  zh: 'cjk',
};

/** Minimum share of counted letters the top script must reach to be "dominant". */
const DOMINANCE_THRESHOLD = 0.3;

/**
 * Classify a single Unicode code point into a writing script, or `null` if it
 * is not a letter in any script we track (digits, punctuation, whitespace,
 * symbols).
 */
export function classifyChar(cp: number): Script | null {
  // Latin: ASCII letters + Latin-1 Supplement/Extended-A/B letters
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return 'latin';
  if (cp >= 0xc0 && cp <= 0x24f && cp !== 0xd7 && cp !== 0xf7) return 'latin';
  if (cp >= 0x370 && cp <= 0x3ff) return 'greek';
  if (cp >= 0x400 && cp <= 0x4ff) return 'cyrillic';
  if (cp >= 0x530 && cp <= 0x58f) return 'armenian';
  if (cp >= 0x590 && cp <= 0x5ff) return 'hebrew';
  if ((cp >= 0x600 && cp <= 0x6ff) || (cp >= 0x750 && cp <= 0x77f))
    return 'arabic';
  if (cp >= 0x900 && cp <= 0x97f) return 'devanagari';
  if (cp >= 0x980 && cp <= 0x9ff) return 'bengali';
  if (cp >= 0xa00 && cp <= 0xa7f) return 'gurmukhi';
  if (cp >= 0xa80 && cp <= 0xaff) return 'gujarati';
  if (cp >= 0xb00 && cp <= 0xb7f) return 'odia';
  if (cp >= 0xb80 && cp <= 0xbff) return 'tamil';
  if (cp >= 0xc00 && cp <= 0xc7f) return 'telugu';
  if (cp >= 0xc80 && cp <= 0xcff) return 'kannada';
  if (cp >= 0xd00 && cp <= 0xd7f) return 'malayalam';
  if (cp >= 0xd80 && cp <= 0xdff) return 'sinhala';
  if (cp >= 0xe00 && cp <= 0xe7f) return 'thai';
  if (cp >= 0xe80 && cp <= 0xeff) return 'lao';
  if (cp >= 0x1000 && cp <= 0x109f) return 'myanmar';
  if (cp >= 0x10a0 && cp <= 0x10ff) return 'georgian';
  if (cp >= 0x1100 && cp <= 0x11ff) return 'hangul'; // Hangul Jamo
  if (cp >= 0x1200 && cp <= 0x137f) return 'ethiopic';
  if (cp >= 0x1780 && cp <= 0x17ff) return 'khmer';
  if (cp >= 0x3040 && cp <= 0x30ff) return 'kana';
  if (cp >= 0x4e00 && cp <= 0x9fff) return 'cjk';
  if (cp >= 0xac00 && cp <= 0xd7af) return 'hangul'; // Hangul Syllables
  return null;
}

/**
 * Compute the dominant script of `text` by counting only letters that fall in a
 * tracked script range (ASCII digits/punctuation/whitespace are ignored). The
 * dominant script must cover at least {@link DOMINANCE_THRESHOLD} of all counted
 * letters; otherwise the text is treated as mixed/unknown and `null` is
 * returned (no override).
 */
export function detectDominantScript(
  text: string,
): { script: Script; ratio: number } | null {
  const counts = new Map<Script, number>();
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const s = classifyChar(cp);
    if (!s) continue;
    counts.set(s, (counts.get(s) ?? 0) + 1);
    total++;
  }
  if (total === 0) return null;

  let best: Script | null = null;
  let bestCount = 0;
  for (const [s, c] of counts) {
    if (c > bestCount) {
      bestCount = c;
      best = s;
    }
  }
  if (!best) return null;

  const ratio = bestCount / total;
  if (ratio < DOMINANCE_THRESHOLD) return null;
  return { script: best, ratio };
}

/** Kana LETTERS only: excludes U+30FB (・) and U+30FC (ー), which Chinese text uses. */
const KANA_LETTER = /[\u3041-\u3096\u30a1-\u30fa]/g;

const HANGUL = /[\uac00-\ud7af\u1100-\u11ff]/g;
const HAN = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
/** Hanja-heavy Korean still runs a fifth hangul or more; a Chinese story quoting
 *  a Korean name in hangul stays well under it. */
const HANGUL_SHARE_FOR_KO = 0.2;

export function hangulShare(text: string): number {
  const hangul = text.match(HANGUL)?.length ?? 0;
  const han = text.match(HAN)?.length ?? 0;
  return hangul + han === 0 ? 0 : hangul / (hangul + han);
}

export function countKanaLetters(text: string): number {
  return text.match(KANA_LETTER)?.length ?? 0;
}

/** True when CLD3's language guess is consistent with the dominant script. */
export function isScriptConsistent(lang: string, script: Script): boolean {
  const expected = LANG_EXPECTED_SCRIPT[lang] ?? 'latin';
  return expected === script;
}

@Injectable()
export class LanguageDetectionService implements OnModuleInit {
  private readonly logger = new Logger(LanguageDetectionService.name);
  private cldFactory: CldFactory | null = null;
  private cldIdentifier: LanguageIdentifier | null = null;

  async onModuleInit() {
    try {
      this.cldFactory = await loadModule();
      this.cldIdentifier = this.cldFactory.create();
      this.logger.log('CLD3 language detector loaded');
    } catch (error) {
      this.logger.error('Failed to load CLD3 module:', error);
    }
  }

  /**
   * Detect the language of `text`, script-guarded around CLD3:
   *
   *  1. Unique-script text (Odia, Tamil, Greek, …) returns the mapped code
   *     directly, ignoring CLD3 — fixes CLD3-unsupported scripts and vetoes
   *     cross-script misdetections.
   *  2. Latin-dominant text keeps raw CLD3 behavior (CLD3 is good there).
   *  3. Ambiguous-script text (Devanagari/Arabic/Cyrillic/CJK) accepts CLD3
   *     only when its guess is script-consistent. CJK is `ko` on CLD3 `ko` or a hangul share of 20% or more, `ja` when CLD3 says
   *     `ja` or the text has kana letters (two against a reliable CLD3 `zh`,
   *     one otherwise), else `zh`; the
   *     rest → `null` (upstream treats null as needs-translation / unknown).
   *  4. Mixed / no-dominant-script text falls through to raw CLD3.
   */
  detectLanguage(text: string): string | null {
    if (!text || text.trim().length === 0) {
      return null;
    }

    if (!this.cldIdentifier) {
      this.logger.warn('CLD3 not loaded, cannot detect language');
      return null;
    }

    const dominant = detectDominantScript(text);

    // 1. Unique-script override — return the mapped code regardless of CLD3.
    if (dominant) {
      const unique = UNIQUE_SCRIPT_LANG[dominant.script];
      if (unique) return unique;
    }

    const cld = this.runCld3(text);

    // 4. No dominant script (mixed / below threshold): trust CLD3 as-is.
    if (!dominant) return cld;

    const script = dominant.script;

    // 2. Latin: CLD3 behavior unchanged.
    if (script === 'latin') return cld;

    // 3. Ambiguous scripts: accept CLD3 only when script-consistent.
    // Kanji-heavy Japanese is CJK-dominant, so the kana override above misses
    // it. Chinese text can quote a kana letter (a Japanese name or title), so a
    // reliable CLD3 `zh` yields only to two or more.
    if (script === 'cjk') {
      if (cld === 'ja') return 'ja';
      const kana = countKanaLetters(text);
      if (kana >= (cld === 'zh' ? 2 : 1)) return 'ja';
      // Hanja-heavy Korean is CJK-dominant too. A share, not any hangul: Chinese
      // stories quote Korean names in hangul, and one feed's first items label it.
      if (cld === 'ko' || hangulShare(text) >= HANGUL_SHARE_FOR_KO) return 'ko';
    }
    if (cld && isScriptConsistent(cld, script)) return cld;
    if (script === 'cjk') return 'zh';
    return null;
  }

  /** Raw CLD3 detection with the original reliability/`und` guards. */
  private runCld3(text: string): string | null {
    try {
      const result = this.cldIdentifier!.findLanguage(text);

      if (!result.is_reliable || (result.language as string) === 'und') {
        return null;
      }

      return result.language;
    } catch (error) {
      this.logger.error('CLD3 language detection failed:', error);
      return null;
    }
  }
}
