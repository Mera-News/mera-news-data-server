import type { TranslateInput } from './translation-provider.port';

/** One aligned translation keyed by the input id. */
export interface TranslatedText {
  title_en: string;
  description_en: string;
}

/**
 * The translation prompt, shared by every provider. The wording is the one the
 * translation bake-off tested verbatim (`eval-data/translation-bakeoff/lib/
 * translate.mjs` `buildPrompt`), so an edit here is a model-behaviour change
 * for Gemini and OpenRouter at once; a fixture test pins the bytes.
 * `sourceLang` goes in raw (the CLD3 code), never the routing-normalised one.
 */
export function buildTranslationPrompt(items: TranslateInput[]): string {
  const lang = items[0]?.sourceLang ?? 'unknown';
  const payload = items.map((i) => ({
    id: i.id,
    title: i.title,
    description: i.description,
  }));
  return [
    `Translate each news article from ${lang} to natural English.`,
    'Preserve meaning, named entities, and tone. Do not add commentary.',
    'Return a JSON array with one object per input article, each having',
    'exactly the fields id, title_en, description_en. The id MUST match the',
    'input id verbatim. Include every input id exactly once.',
    '',
    `Articles: ${JSON.stringify(payload)}`,
  ].join('\n');
}

/**
 * Gemini's strict parse: the text must JSON.parse to a bare array; keep only
 * input ids, each exactly once; extra, duplicate and ill-typed rows are
 * ignored. Gemini honours `responseSchema`, so it gets no leniency.
 */
export function parseAlignedTranslations(
  text: string,
  items: TranslateInput[],
): Map<string, TranslatedText> {
  const inputIds = new Set(items.map((i) => i.id));
  const seen = new Set<string>();
  const byId = new Map<string, TranslatedText>();
  let arr: unknown;
  try {
    arr = JSON.parse(text);
  } catch {
    return byId;
  }
  if (!Array.isArray(arr)) return byId;
  for (const row of arr) {
    const r = row as {
      id?: unknown;
      title_en?: unknown;
      description_en?: unknown;
    };
    const id = typeof r?.id === 'string' ? r.id : undefined;
    if (!id || !inputIds.has(id) || seen.has(id)) continue;
    if (typeof r.title_en !== 'string' || typeof r.description_en !== 'string')
      continue;
    seen.add(id);
    byId.set(id, { title_en: r.title_en, description_en: r.description_en });
  }
  return byId;
}

/**
 * Recover the JSON array from a chat model's reply: drop a leaked reasoning
 * trace (everything up to the last `</think>`), strip a ``` fence, unwrap an
 * object holding exactly one array, else take the outermost `[...]`. Ported
 * from the bake-off's `lenientText`; every OpenRouter model tested needed it.
 */
export function lenientTranslationText(text: string): string {
  let t = text || '';
  const think = t.lastIndexOf('</think>');
  if (think >= 0) t = t.slice(think + '</think>'.length);
  t = t
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '');
  try {
    const p: unknown = JSON.parse(t);
    if (!Array.isArray(p) && p && typeof p === 'object') {
      const arrays = Object.values(p).filter(Array.isArray);
      if (arrays.length === 1) return JSON.stringify(arrays[0]);
    }
    return t;
  } catch {
    const a = t.indexOf('[');
    const b = t.lastIndexOf(']');
    if (a >= 0 && b > a) {
      try {
        JSON.parse(t.slice(a, b + 1));
        return t.slice(a, b + 1);
      } catch {
        // fall through: nothing recoverable
      }
    }
  }
  return t;
}

/**
 * The OpenRouter parse: {@link lenientTranslationText}, then the same
 * every-id-exactly-once alignment as the strict parse, plus two rules no
 * Gemini output needs:
 *  - `title` / `description` are accepted when `title_en` / `description_en`
 *    are ABSENT from the row (some models mirror the input keys). A present
 *    `_en` key always wins, and a present-but-empty one is never replaced.
 *  - Echo guard: a trimmed title that is empty or equals the source title is a
 *    MISS, so the article is retried rather than stored untranslated.
 * Nothing here is specific to one model.
 */
export function parseLenientTranslations(
  text: string,
  items: TranslateInput[],
): Map<string, TranslatedText> {
  const sourceById = new Map(items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const byId = new Map<string, TranslatedText>();
  let arr: unknown;
  try {
    arr = JSON.parse(lenientTranslationText(text));
  } catch {
    return byId;
  }
  if (!Array.isArray(arr)) return byId;
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id : undefined;
    const source = id ? sourceById.get(id) : undefined;
    if (!id || !source || seen.has(id)) continue;
    const title = 'title_en' in r ? r.title_en : r.title;
    const description =
      'description_en' in r ? r.description_en : r.description;
    if (typeof title !== 'string' || typeof description !== 'string') continue;
    const trimmed = title.trim();
    if (!trimmed || trimmed === (source.title ?? '').trim()) continue;
    seen.add(id);
    byId.set(id, { title_en: title, description_en: description });
  }
  return byId;
}
