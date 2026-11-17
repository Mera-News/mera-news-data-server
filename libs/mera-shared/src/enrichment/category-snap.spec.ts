import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NLP_CATEGORY_NODES } from './nlp-category-tree';
import {
  dedupeCategoryPaths,
  isNlpCategoryNode,
  normalizeCategoryPaths,
  snapCategory,
} from './category-snap';

describe('nlp-category-tree', () => {
  it('holds every seed path plus every intermediate ancestor, 1,094 nodes, sorted', () => {
    const seed = JSON.parse(
      readFileSync(
        join(
          __dirname,
          '../../../../apps/mera-scripts/seed-data/google-nlp-categories.json',
        ),
        'utf8',
      ),
    ) as string[];
    const nodes = new Set<string>();
    for (const p of seed) {
      const parts = p.split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        nodes.add('/' + parts.slice(0, i).join('/'));
      }
    }
    const expected = [...nodes].sort();
    expect(NLP_CATEGORY_NODES).toHaveLength(1094);
    expect([...NLP_CATEGORY_NODES]).toEqual(expected);
  });
});

describe('snapCategory', () => {
  it('keeps an exact node', () => {
    expect(snapCategory('/Sports/Team Sports/Soccer')).toEqual({
      path: '/Sports/Team Sports/Soccer',
      how: 'exact',
    });
  });

  it('treats " and " as "&" and trims segments', () => {
    expect(snapCategory('/ Business and Industrial ')).toEqual({
      path: '/Business & Industrial',
      how: 'exact',
    });
  });

  it('resolves a case mismatch', () => {
    expect(snapCategory('/sports/team sports/soccer')).toEqual({
      path: '/Sports/Team Sports/Soccer',
      how: 'case',
    });
  });

  it('finds the same leaf label elsewhere in the tree', () => {
    expect(snapCategory('/Recreation/Soccer')).toEqual({
      path: '/Sports/Team Sports/Soccer',
      how: 'label',
    });
  });

  it('an unknown leaf under a known parent resolves through the parent label', () => {
    // The label pass runs deepest-first, so a valid intermediate segment is
    // caught there before the ancestor pass: same answer, recorded as 'label'.
    expect(snapCategory('/Sports/Team Sports/Zorbing League')).toEqual({
      path: '/Sports/Team Sports',
      how: 'label',
    });
  });

  it('falls back to the valid top-level ancestor', () => {
    expect(snapCategory('/sports/Zorbing')).toEqual({
      path: '/Sports',
      how: 'ancestor',
    });
  });

  it('drops a path with nothing recognisable', () => {
    expect(snapCategory('/Zzz/Qqq')).toEqual({ path: null });
    expect(snapCategory('')).toEqual({ path: null });
    expect(snapCategory(42)).toEqual({ path: null });
  });
});

describe('dedupeCategoryPaths', () => {
  it('drops an ancestor of a kept path, in either order, and caps at 3', () => {
    expect(
      dedupeCategoryPaths([
        '/Sports',
        '/Sports/Team Sports/Soccer',
        '/News/Politics',
        '/News',
        '/News/Politics',
        '/Business & Industrial',
        '/Health',
      ]),
    ).toEqual([
      '/Sports/Team Sports/Soccer',
      '/News/Politics',
      '/Business & Industrial',
    ]);
  });
});

describe('normalizeCategoryPaths', () => {
  it('snaps, drops unresolvable entries and dedupes', () => {
    expect(
      normalizeCategoryPaths([
        '/sports/team sports/soccer',
        '/Sports/Team Sports',
        '/Zzz',
        7,
      ]),
    ).toEqual(['/Sports/Team Sports/Soccer']);
    expect(normalizeCategoryPaths('not an array')).toEqual([]);
  });

  it('recognises tree nodes verbatim only', () => {
    expect(isNlpCategoryNode('/News/Politics')).toBe(true);
    expect(isNlpCategoryNode('/news/politics')).toBe(false);
    expect(isNlpCategoryNode(null)).toBe(false);
  });
});
