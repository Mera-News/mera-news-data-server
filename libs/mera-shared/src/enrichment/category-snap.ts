import { NLP_CATEGORY_NODES } from './nlp-category-tree';

/**
 * Code-side resolution of a model-generated content-category path onto the
 * Google NLP tree. Nothing about the taxonomy is sent to the model; it names a
 * path from its own knowledge and this snaps it. Ported from `snapCategory` in
 * apps/mera-scripts/eval-data/enrichment-bakeoff/lib/vertex.mjs, where the
 * held-out scores were measured.
 */

export type SnapHow = 'exact' | 'case' | 'label' | 'ancestor';

export interface SnapResult {
  path: string | null;
  how?: SnapHow;
}

const NODE_SET: ReadonlySet<string> = new Set(NLP_CATEGORY_NODES);
const BY_LOWER = new Map<string, string>(
  NLP_CATEGORY_NODES.map((n) => [n.toLowerCase(), n]),
);
const BY_LABEL = new Map<string, string[]>();
for (const n of NLP_CATEGORY_NODES) {
  const label = n.slice(n.lastIndexOf('/') + 1).toLowerCase();
  const hits = BY_LABEL.get(label);
  if (hits) hits.push(n);
  else BY_LABEL.set(label, [n]);
}

/** Whether `path` is a node of the NLP tree, verbatim. */
export function isNlpCategoryNode(path: unknown): path is string {
  return typeof path === 'string' && NODE_SET.has(path);
}

/**
 * exact → case and " and "/"&" insensitive → the same leaf label elsewhere in
 * the tree (preferring the model's own top level, trying segments from the
 * deepest up) → the longest valid ancestor → a top-level label match → drop.
 */
export function snapCategory(path: unknown): SnapResult {
  if (typeof path !== 'string') return { path: null };
  const parts = path
    .split('/')
    .map((x) => x.trim().replace(/\s+and\s+/gi, ' & '))
    .filter(Boolean);
  if (parts.length === 0) return { path: null };
  const clean = '/' + parts.join('/');
  if (NODE_SET.has(clean)) return { path: clean, how: 'exact' };
  const lower = BY_LOWER.get(clean.toLowerCase());
  if (lower) return { path: lower, how: 'case' };

  const l1 = BY_LOWER.get('/' + parts[0].toLowerCase());
  for (let i = parts.length - 1; i >= 1; i--) {
    const hits = BY_LABEL.get(parts[i].toLowerCase());
    if (hits?.length) {
      const sameL1 = l1 ? hits.find((h) => h.startsWith(l1 + '/')) : undefined;
      return { path: sameL1 ?? hits[0], how: 'label' };
    }
  }
  for (let i = parts.length - 1; i >= 1; i--) {
    const p = BY_LOWER.get(('/' + parts.slice(0, i).join('/')).toLowerCase());
    if (p) return { path: p, how: 'ancestor' };
  }
  const top = BY_LABEL.get(parts[0].toLowerCase());
  return top?.length ? { path: top[0], how: 'label' } : { path: null };
}

/**
 * Drop any path that is an ancestor of another kept path (the more specific
 * one wins), drop duplicates, keep first-seen order otherwise, then cap.
 */
export function dedupeCategoryPaths(paths: string[], cap = 3): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (out.includes(p)) continue;
    if (out.some((q) => q.startsWith(p + '/'))) continue;
    for (let i = out.length - 1; i >= 0; i--) {
      if (p.startsWith(out[i] + '/')) out.splice(i, 1);
    }
    out.push(p);
  }
  return out.slice(0, cap);
}

/** Snap every raw path, drop unresolvable ones, prefix-dedupe and cap at 3. */
export function normalizeCategoryPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const snapped: string[] = [];
  for (const r of raw) {
    const s = snapCategory(r);
    if (s.path) snapped.push(s.path);
  }
  return dedupeCategoryPaths(snapped);
}
