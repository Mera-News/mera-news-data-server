/**
 * Exact-copy keys for an article URL: two articles sharing any key are the same
 * report, whatever their text. Stamped on `news-article.copy_keys` at ingest and
 * read by the story-key index as its layer 1 (before any near-text match).
 *
 *   dpg:<id>          DPG Media's CMS id (`...-slug~a1b2c3d4/`). One id runs on
 *                     every regional title (ad.nl, bd.nl, pzc.nl, ...) and on
 *                     hln.be / 7sur7.be (the French edition). Live blogs are
 *                     excluded: they keep one id while the headline changes per
 *                     update, so each update is its own story.
 *   <host>:<id>       an allowlisted site whose numeric id survives a change of
 *                     section path or language prefix (telegraaf double paths,
 *                     rbc.ua's /rus/ and /ukr/ editions). Allowlisted, never
 *                     guessed: a generic "long digit run" rule merges dates,
 *                     prices and unrelated ids.
 *   url:<articleUrlKey>  the same page reached through tracking or casing variants.
 *
 * Pure. A calibration script ports these rules to plain JS; the hex fixtures in
 * the spec are what keep the two in step.
 */
import { articleUrlKey } from './normalize-article-url';

const DPG_HOSTS = new Set([
  'ad.nl',
  'bd.nl',
  'bndestem.nl',
  'destentor.nl',
  'ed.nl',
  'gelderlander.nl',
  'pzc.nl',
  'tubantia.nl',
  'parool.nl',
  'trouw.nl',
  'volkskrant.nl',
  'hln.be',
  '7sur7.be',
  'demorgen.be',
  'humo.be',
]);

const DPG_ID = /~([ab][0-9a-f]{7})\/?$/;
const LIVE_BLOG_SLUG = /(?:^|\/)live(?:blog)?-[^/]*$/;

/** host predicate, id pattern on the pathname. */
const NUMERIC_ID_SITES: ReadonlyArray<[(host: string) => boolean, RegExp]> = [
  [(h) => h === 'telegraaf.nl', /\/(\d{6,})\.html$/],
  [(h) => h === 'omroepbrabant.nl', /^\/nieuws\/(\d{6,})(?:\/|$)/],
  [(h) => h === 'rbc.ua' || h.endsWith('.rbc.ua'), /-(\d{7,})\.html$/],
];

export function buildArticleCopyKeys(rawUrl: string): string[] {
  const keys = [`url:${articleUrlKey(rawUrl)}`];
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return keys;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '');

  if (DPG_HOSTS.has(host)) {
    const id = DPG_ID.exec(url.pathname)?.[1];
    if (id && !LIVE_BLOG_SLUG.test(path.replace(/~[^/]*$/, ''))) {
      keys.push(`dpg:${id}`);
    }
  }
  for (const [matches, pattern] of NUMERIC_ID_SITES) {
    if (!matches(host)) continue;
    const id = pattern.exec(path)?.[1];
    if (id) keys.push(`${host}:${id}`);
  }
  return keys;
}
