// A copy of the full server's language detection, kept to what the
// one-computer setup calls: CLD3, overruled by the dominant writing script.
// The parity test runs both on the same texts.
import { loadModule, type LanguageIdentifier } from 'cld3-asm';

type Script =
  | 'latin' | 'greek' | 'cyrillic' | 'armenian' | 'hebrew' | 'arabic' | 'devanagari' | 'bengali'
  | 'gurmukhi' | 'gujarati' | 'odia' | 'tamil' | 'telugu' | 'kannada' | 'malayalam' | 'sinhala'
  | 'thai' | 'lao' | 'myanmar' | 'georgian' | 'ethiopic' | 'khmer' | 'kana' | 'cjk' | 'hangul';

// Scripts that mean one language in news; the mapped code wins over CLD3.
const UNIQUE_SCRIPT_LANG: Partial<Record<Script, string>> = {
  odia: 'or', tamil: 'ta', telugu: 'te', kannada: 'kn', malayalam: 'ml', gujarati: 'gu',
  gurmukhi: 'pa', sinhala: 'si', thai: 'th', lao: 'lo', myanmar: 'my', georgian: 'ka',
  khmer: 'km', greek: 'el', hangul: 'ko', kana: 'ja', ethiopic: 'am', armenian: 'hy',
  hebrew: 'iw', bengali: 'bn',
};

// For the scripts several languages share: CLD3's answer must match the script.
const LANG_EXPECTED_SCRIPT: Record<string, Script> = {
  or: 'odia', ta: 'tamil', te: 'telugu', kn: 'kannada', ml: 'malayalam', gu: 'gujarati',
  pa: 'gurmukhi', si: 'sinhala', th: 'thai', lo: 'lao', my: 'myanmar', ka: 'georgian',
  km: 'khmer', el: 'greek', ko: 'hangul', ja: 'kana', am: 'ethiopic', hy: 'armenian',
  iw: 'hebrew', he: 'hebrew', bn: 'bengali',
  hi: 'devanagari', mr: 'devanagari', ne: 'devanagari', sa: 'devanagari', kok: 'devanagari',
  mai: 'devanagari', bho: 'devanagari',
  ar: 'arabic', ur: 'arabic', fa: 'arabic', ps: 'arabic', sd: 'arabic', ug: 'arabic', ckb: 'arabic',
  ru: 'cyrillic', uk: 'cyrillic', bg: 'cyrillic', mk: 'cyrillic', sr: 'cyrillic', kk: 'cyrillic',
  ky: 'cyrillic', tg: 'cyrillic', mn: 'cyrillic', be: 'cyrillic',
  zh: 'cjk',
};

const DOMINANCE_THRESHOLD = 0.3;
const HANGUL_SHARE_FOR_KO = 0.2;
const KANA_LETTER = /[ぁ-ゖァ-ヺ]/g;
const HANGUL = /[가-힯ᄀ-ᇿ]/g;
const HAN = /[一-鿿㐀-䶿]/g;

function classifyChar(cp: number): Script | null {
  if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) return 'latin';
  if (cp >= 0xc0 && cp <= 0x24f && cp !== 0xd7 && cp !== 0xf7) return 'latin';
  if (cp >= 0x370 && cp <= 0x3ff) return 'greek';
  if (cp >= 0x400 && cp <= 0x4ff) return 'cyrillic';
  if (cp >= 0x530 && cp <= 0x58f) return 'armenian';
  if (cp >= 0x590 && cp <= 0x5ff) return 'hebrew';
  if ((cp >= 0x600 && cp <= 0x6ff) || (cp >= 0x750 && cp <= 0x77f)) return 'arabic';
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
  if (cp >= 0x1100 && cp <= 0x11ff) return 'hangul';
  if (cp >= 0x1200 && cp <= 0x137f) return 'ethiopic';
  if (cp >= 0x1780 && cp <= 0x17ff) return 'khmer';
  if (cp >= 0x3040 && cp <= 0x30ff) return 'kana';
  if (cp >= 0x4e00 && cp <= 0x9fff) return 'cjk';
  if (cp >= 0xac00 && cp <= 0xd7af) return 'hangul';
  return null;
}

function dominantScript(text: string): Script | null {
  const counts = new Map<Script, number>();
  let total = 0;
  for (const ch of text) {
    const s = classifyChar(ch.codePointAt(0)!);
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
  return best && bestCount / total >= DOMINANCE_THRESHOLD ? best : null;
}

function hangulShare(text: string): number {
  const hangul = text.match(HANGUL)?.length ?? 0;
  const han = text.match(HAN)?.length ?? 0;
  return hangul + han === 0 ? 0 : hangul / (hangul + han);
}

export interface LanguageDetector {
  /** A CLD3 code such as `en`, `ja` or `iw`, or null when the text says too little. */
  detect(text: string): string | null;
}

export async function createLanguageDetector(): Promise<LanguageDetector> {
  const identifier: LanguageIdentifier = (await loadModule()).create();
  const runCld3 = (text: string): string | null => {
    try {
      const result = identifier.findLanguage(text);
      return !result.is_reliable || (result.language as string) === 'und' ? null : result.language;
    } catch {
      return null;
    }
  };
  return {
    detect(text: string): string | null {
      if (!text || text.trim().length === 0) return null;
      const script = dominantScript(text);
      if (script) {
        const unique = UNIQUE_SCRIPT_LANG[script];
        if (unique) return unique;
      }
      const cld = runCld3(text);
      if (!script || script === 'latin') return cld;
      if (script === 'cjk') {
        if (cld === 'ja') return 'ja';
        const kana = text.match(KANA_LETTER)?.length ?? 0;
        if (kana >= (cld === 'zh' ? 2 : 1)) return 'ja';
        if (cld === 'ko' || hangulShare(text) >= HANGUL_SHARE_FOR_KO) return 'ko';
      }
      if (cld && (LANG_EXPECTED_SCRIPT[cld] ?? 'latin') === script) return cld;
      if (script === 'cjk') return 'zh';
      return null;
    },
  };
}

/**
 * The feed's language as the full server's ingest decides it: detected from the first two
 * items, else the feed's declared language unless it says English (publishers leave that
 * default unchanged).
 */
export function feedLanguage(
  detector: LanguageDetector,
  items: { title: string; description: string | null }[],
  declared: string | null,
): string | null {
  for (const item of items.slice(0, 2)) {
    const text = `${item.title || ''} ${item.description || ''}`.slice(0, 500);
    if (!text.trim()) continue;
    const found = detector.detect(text);
    if (found) return found;
  }
  const feed = declared?.trim() || null;
  return feed && !feed.toLowerCase().startsWith('en') ? feed : null;
}

/**
 * One article's language as the full server's translate step decides it: title, then
 * description (a Japanese description overrules a kanji title read as Chinese), then both
 * together. Falls back to the feed's language.
 */
export function articleLanguage(
  detector: LanguageDetector,
  title: string,
  description: string | null,
  feed: string | null,
): string | null {
  const t = detector.detect(title);
  const perField =
    t === 'zh' && description && detector.detect(description) === 'ja'
      ? 'ja'
      : t || (description ? detector.detect(description) : null) || null;
  return perField ?? detector.detect(`${title} ${description ?? ''}`) ?? feed;
}
