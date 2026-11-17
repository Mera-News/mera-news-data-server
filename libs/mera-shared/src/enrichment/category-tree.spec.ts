import chosen from '../../../../apps/mera-scripts/eval-data/category-tree/chosen.json';
import fixtures from '../../../../apps/mera-scripts/eval-data/category-tree/fixtures.json';
import { buildArticleData } from '../article-data/article-data';
import { NLP_CATEGORY_NODES } from './nlp-category-tree';
import {
  CANONICAL_L1_GATE,
  CANONICAL_TOPIC_LEVELS,
  CATEGORY_TREE_EXCLUDED_ROOTS,
  canonicalTopicText,
  categoryCentroid,
  categoryLabelText,
  categoryLevel,
  categoryParent,
  categoryTreeNodes,
  classifyCanonical,
} from './category-tree';

describe('category-tree', () => {
  it('serves exactly what the measurement chose', () => {
    expect(chosen.variant).toBe('centroid');
    expect(chosen.classifier).toBe('flat');
    expect(CANONICAL_TOPIC_LEVELS).toEqual(chosen.levels);
    expect(CATEGORY_TREE_EXCLUDED_ROOTS).toEqual(chosen.excludedRoots);
    expect(CANONICAL_L1_GATE).toEqual(chosen.gate['1']);
  });

  it('embeds the same texts the measurement embedded', () => {
    for (const { path, text } of fixtures.labels) {
      expect(categoryLabelText(path)).toBe(text);
    }
    for (const { title, description, text } of fixtures.articles) {
      expect(buildArticleData(title, description, null, null)).toBe(text);
    }
  });

  it('drops the excluded subtrees and nothing else', () => {
    const nodes = categoryTreeNodes();
    expect(nodes.some((p) => p.startsWith('/Adult'))).toBe(false);
    expect(nodes.some((p) => p.startsWith('/Online Communities'))).toBe(false);
    const excluded = NLP_CATEGORY_NODES.filter(
      (p) => p.startsWith('/Adult') || p.startsWith('/Online Communities'),
    ).length;
    expect(nodes).toHaveLength(NLP_CATEGORY_NODES.length - excluded);
    expect(nodes.filter((p) => categoryLevel(p) === 1)).toHaveLength(25);
  });

  it('names paths', () => {
    expect(canonicalTopicText('/Sports')).toBe('cat:/Sports');
    expect(categoryLevel('/Sports/Individual Sports/Cycling')).toBe(3);
    expect(categoryParent('/Sports/Individual Sports')).toBe('/Sports');
    expect(categoryParent('/Sports')).toBeNull();
  });

  it('takes the centroid over the node and its descendants only', () => {
    const vectors: Record<string, number[]> = {
      '/A': [1, 0, 0],
      '/A/B': [0, 1, 0],
      '/AB': [0, 0, 1], // shares the prefix, not a descendant
    };
    const c = categoryCentroid('/A', Object.keys(vectors), (p) => vectors[p]);
    expect(c[0]).toBeCloseTo(Math.SQRT1_2);
    expect(c[1]).toBeCloseTo(Math.SQRT1_2);
    expect(c[2]).toBe(0);
  });

  it('makes the measured flat decisions', () => {
    // One basis vector per root makes each dot product exactly the recorded score.
    for (const { scores, pick, confidence } of fixtures.flat) {
      const paths = Object.keys(scores) as Array<keyof typeof scores>;
      const index = paths.map((p, i) => ({
        topicId: p,
        vector: paths.map((_, j) => (i === j ? 1 : 0)),
      }));
      const links = classifyCanonical(
        paths.map((p) => scores[p]),
        index,
      );
      expect(links).toEqual(pick ? [{ topicId: pick, confidence }] : []);
    }
    expect(fixtures.flat.some((f) => f.pick)).toBe(true);
    expect(fixtures.flat.some((f) => !f.pick)).toBe(true);
  });

  it('links only above the floor and the margin', () => {
    const index = [
      { topicId: 'a', vector: [1, 0] },
      { topicId: 'b', vector: [0, 1] },
    ];
    const { floor, margin } = CANONICAL_L1_GATE;
    expect(classifyCanonical([0.9, 0.5], index)).toEqual([
      { topicId: 'a', confidence: 0.9 },
    ]);
    expect(classifyCanonical([floor - 0.01, 0], index)).toEqual([]);
    expect(classifyCanonical([0.9, 0.9 - margin / 2], index)).toEqual([]);
  });

  it('links nothing with no index', () => {
    expect(classifyCanonical([1, 0], [])).toEqual([]);
  });
});
