import 'reflect-metadata';
import {
  buildScopeEdition,
  GLOBAL_SCOPE_KEY,
  HeadlineArticleInput,
  HeadlineClusterInput,
  HeadlineLinkInput,
  HeadlineSourceMeta,
  HEADLINE_GLOBAL_MARKET_CAP,
  WIRE_COUNTRY_CODE,
} from './headline-edition-builder';

/** Build a lean article input with sane defaults. */
function article(
  overrides: Partial<HeadlineArticleInput> & { _id: string },
): HeadlineArticleInput {
  return {
    publicationSourceId: 'src-x',
    createdAt: new Date('2026-07-20T10:00:00Z'),
    pubDate: new Date('2026-07-20T10:00:00Z'),
    image_url: null,
    ...overrides,
  };
}

function linkMap(
  entries: Array<[string, HeadlineLinkInput]>,
): Map<string, HeadlineLinkInput> {
  return new Map(entries);
}

function clusterMap(
  entries: Array<[string, HeadlineClusterInput]>,
): Map<string, HeadlineClusterInput> {
  return new Map(entries);
}

/** Deterministic Fisher-Yates using a fixed sequence (no Math.random). */
function shuffle<T>(input: T[], seed: number[]): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = seed[i % seed.length] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

describe('buildScopeEdition', () => {
  it('returns an empty edition for an empty scope', () => {
    const result = buildScopeEdition(
      'GLOBAL',
      [],
      linkMap([]),
      clusterMap([]),
      100,
    );
    expect(result).toEqual([]);
  });

  it('groups in-scope articles by cluster and dedups to one entry per cluster', () => {
    const articles = [
      article({ _id: 'art-01' }),
      article({ _id: 'art-02' }),
      article({ _id: 'art-03' }),
    ];
    const links = linkMap([
      ['art-01', { clusterId: 'cl-1', confidence: 0.9 }],
      ['art-02', { clusterId: 'cl-1', confidence: 0.5 }],
      ['art-03', { clusterId: 'cl-2', confidence: 0.8 }],
    ]);
    const clusters = clusterMap([
      ['cl-1', { clusterSize: 5, stableClusterId: 'stable-1' }],
      ['cl-2', { clusterSize: 2, stableClusterId: 'stable-2' }],
    ]);

    const result = buildScopeEdition('GLOBAL', articles, links, clusters, 100);

    expect(result).toHaveLength(2);
    const cl1 = result.find((e) => e.clusterId === 'cl-1');
    expect(cl1?.inScopeCount).toBe(2);
    expect(cl1?.clusterSize).toBe(5);
    expect(cl1?.stableClusterId).toBe('stable-1');
  });

  it('ranks clusters: inScopeCount desc → clusterSize desc → newest createdAt desc → clusterId asc', () => {
    // A: inScopeCount 2 (should win on primary key)
    // B & C: inScopeCount 1, differ on clusterSize
    // D & E: inScopeCount 1, same clusterSize, differ on newest createdAt
    // F & G: inScopeCount 1, same size, same createdAt, differ on clusterId
    const base = new Date('2026-07-20T08:00:00Z');
    const newer = new Date('2026-07-20T12:00:00Z');
    const articles = [
      article({ _id: 'a1', createdAt: base }),
      article({ _id: 'a2', createdAt: base }),
      article({ _id: 'b1', createdAt: base }),
      article({ _id: 'c1', createdAt: base }),
      article({ _id: 'd1', createdAt: newer }),
      article({ _id: 'e1', createdAt: base }),
      article({ _id: 'f1', createdAt: base }),
      article({ _id: 'g1', createdAt: base }),
    ];
    const links = linkMap([
      ['a1', { clusterId: 'clA', confidence: 0.5 }],
      ['a2', { clusterId: 'clA', confidence: 0.5 }],
      ['b1', { clusterId: 'clB', confidence: 0.5 }],
      ['c1', { clusterId: 'clC', confidence: 0.5 }],
      ['d1', { clusterId: 'clD', confidence: 0.5 }],
      ['e1', { clusterId: 'clE', confidence: 0.5 }],
      ['f1', { clusterId: 'clF', confidence: 0.5 }],
      ['g1', { clusterId: 'clG', confidence: 0.5 }],
    ]);
    const clusters = clusterMap([
      ['clA', { clusterSize: 2, stableClusterId: null }],
      ['clB', { clusterSize: 9, stableClusterId: null }],
      ['clC', { clusterSize: 3, stableClusterId: null }],
      ['clD', { clusterSize: 4, stableClusterId: null }],
      ['clE', { clusterSize: 4, stableClusterId: null }],
      ['clF', { clusterSize: 4, stableClusterId: null }],
      ['clG', { clusterSize: 4, stableClusterId: null }],
    ]);

    const result = buildScopeEdition('GLOBAL', articles, links, clusters, 100);
    const order = result.map((e) => e.clusterId);

    // A first (inScopeCount 2). Then B (size 9) before C (size 3).
    expect(order[0]).toBe('clA');
    expect(order.indexOf('clB')).toBeLessThan(order.indexOf('clC'));
    // D (newer createdAt) before E (both size 4, D newer).
    expect(order.indexOf('clD')).toBeLessThan(order.indexOf('clE'));
    // F before G (same size + createdAt → clusterId asc).
    expect(order.indexOf('clF')).toBeLessThan(order.indexOf('clG'));
    // rank mirrors index.
    result.forEach((e, i) => expect(e.rank).toBe(i));
  });

  const LATE_INGEST = new Date('2026-07-20T23:00:00Z');
  const repSeeds = [
    [2, 0, 1],
    [1, 2, 0],
    [0, 1, 2],
  ];
  const oneCluster = (ids: string[], confidence = 0.5) =>
    linkMap(ids.map((id) => [id, { clusterId: 'cl-1', confidence }]));
  const cl1 = clusterMap([['cl-1', { clusterSize: 3, stableClusterId: null }]]);
  const repOf = (
    members: HeadlineArticleInput[],
    links: Map<string, HeadlineLinkInput>,
  ) =>
    repSeeds.map(
      (seed) =>
        buildScopeEdition('GLOBAL', shuffle(members, seed), links, cl1, 100)[0]
          .articleId,
    );

  it('picks the newest imaged member, regardless of input order and confidence', () => {
    // Representative order: hasImage desc → publishedAt desc → _id desc.
    const members = [
      article({
        _id: 'm-noimg-newest',
        image_url: null,
        createdAt: LATE_INGEST,
        pubDate: new Date('2026-07-20T20:00:00Z'),
      }),
      article({
        _id: 'm-img-older',
        image_url: 'http://img/a.jpg',
        createdAt: LATE_INGEST,
        pubDate: new Date('2026-07-20T05:00:00Z'),
      }),
      article({
        _id: 'm-img-newer',
        image_url: 'http://img/b.jpg',
        createdAt: LATE_INGEST,
        pubDate: new Date('2026-07-20T10:00:00Z'),
      }),
    ];
    // Confidence would pick m-img-older; it no longer decides.
    const links = linkMap([
      ['m-noimg-newest', { clusterId: 'cl-1', confidence: 0.99 }],
      ['m-img-older', { clusterId: 'cl-1', confidence: 0.9 }],
      ['m-img-newer', { clusterId: 'cl-1', confidence: 0.2 }],
    ]);
    expect(repOf(members, links)).toEqual(Array(3).fill('m-img-newer'));
  });

  it('falls back to the newest member when none has an image', () => {
    const members = [
      article({
        _id: 'm-old',
        createdAt: LATE_INGEST,
        pubDate: new Date('2026-07-20T01:00:00Z'),
      }),
      article({
        _id: 'm-new',
        createdAt: LATE_INGEST,
        pubDate: new Date('2026-07-20T20:00:00Z'),
      }),
      article({
        _id: 'm-mid',
        createdAt: LATE_INGEST,
        pubDate: new Date('2026-07-20T10:00:00Z'),
      }),
    ];
    expect(repOf(members, oneCluster(['m-old', 'm-new', 'm-mid']))).toEqual(
      Array(3).fill('m-new'),
    );
  });

  it('clamps a future pubDate to ingest time and reads an invalid one as ingest time', () => {
    const members = [
      // Claims next week, ingested at 09:00: counts as 09:00.
      article({
        _id: 'm-future',
        createdAt: new Date('2026-07-20T09:00:00Z'),
        pubDate: new Date('2026-07-27T09:00:00Z'),
      }),
      article({
        _id: 'm-recent',
        createdAt: new Date('2026-07-20T11:05:00Z'),
        pubDate: new Date('2026-07-20T11:00:00Z'),
      }),
      article({
        _id: 'm-undated',
        createdAt: new Date('2026-07-20T10:00:00Z'),
        pubDate: new Date('not a date'),
      }),
    ];
    expect(
      repOf(members, oneCluster(['m-future', 'm-recent', 'm-undated'])),
    ).toEqual(Array(3).fill('m-recent'));
    const undatedNewest = members.map((m) =>
      m._id === 'm-undated'
        ? { ...m, createdAt: new Date('2026-07-20T12:00:00Z') }
        : m,
    );
    expect(
      repOf(undatedNewest, oneCluster(['m-future', 'm-recent', 'm-undated'])),
    ).toEqual(Array(3).fill('m-undated'));
  });

  it('appends unclustered articles as singletons after clusters, newest first', () => {
    const articles = [
      article({
        _id: 'clustered',
        createdAt: new Date('2026-07-20T09:00:00Z'),
      }),
      article({
        _id: 'single-old',
        createdAt: new Date('2026-07-20T01:00:00Z'),
      }),
      article({
        _id: 'single-new',
        createdAt: new Date('2026-07-20T23:00:00Z'),
      }),
    ];
    const links = linkMap([
      ['clustered', { clusterId: 'cl-1', confidence: 0.5 }],
      // single-old has a link but its cluster is NOT live → treated as singleton.
      ['single-old', { clusterId: 'missing-cluster', confidence: 0.5 }],
      // single-new has no link at all.
    ]);
    const clusters = clusterMap([
      ['cl-1', { clusterSize: 4, stableClusterId: null }],
    ]);

    const result = buildScopeEdition('GLOBAL', articles, links, clusters, 100);

    expect(result.map((e) => e.articleId)).toEqual([
      'clustered',
      'single-new',
      'single-old',
    ]);
    const singletons = result.slice(1);
    singletons.forEach((s) => {
      expect(s.clusterId).toBeNull();
      expect(s.stableClusterId).toBeNull();
      expect(s.clusterSize).toBe(0);
      expect(s.inScopeCount).toBe(1);
    });
  });

  it('truncates to the cap and re-ranks', () => {
    const articles = Array.from({ length: 10 }, (_, i) =>
      article({ _id: `s-${String(i).padStart(2, '0')}` }),
    );
    const result = buildScopeEdition(
      'GLOBAL',
      articles,
      linkMap([]),
      clusterMap([]),
      3,
    );
    expect(result).toHaveLength(3);
    expect(result.map((e) => e.rank)).toEqual([0, 1, 2]);
  });

  it('reflects scope membership — a country scope only sees its own articles', () => {
    // Simulates what the service passes: GLOBAL gets all, a country gets a subset.
    const usArticle = article({ _id: 'us-1' });
    const inArticle = article({ _id: 'in-1' });
    const links = linkMap([
      ['us-1', { clusterId: 'cl-us', confidence: 0.5 }],
      ['in-1', { clusterId: 'cl-in', confidence: 0.5 }],
    ]);
    const clusters = clusterMap([
      ['cl-us', { clusterSize: 3, stableClusterId: null }],
      ['cl-in', { clusterSize: 3, stableClusterId: null }],
    ]);

    const global = buildScopeEdition(
      'GLOBAL',
      [usArticle, inArticle],
      links,
      clusters,
      100,
    );
    const us = buildScopeEdition('US', [usArticle], links, clusters, 100);

    expect(global).toHaveLength(2);
    expect(us).toHaveLength(1);
    expect(us[0].articleId).toBe('us-1');
  });

  it('falls back to clusterSize 0 / null stable id when cluster metadata is absent', () => {
    const articles = [article({ _id: 'a1' })];
    const links = linkMap([['a1', { clusterId: 'cl-1', confidence: 0.5 }]]);
    // cluster-article-link points at cl-1 but no news-cluster metadata exists.
    const result = buildScopeEdition(
      'GLOBAL',
      articles,
      links,
      clusterMap([]),
      100,
    );
    // Treated as a singleton (cluster not live).
    expect(result).toHaveLength(1);
    expect(result[0].clusterId).toBeNull();
    expect(result[0].clusterSize).toBe(0);
  });
});

describe('buildScopeEdition — story_key singleton dedup', () => {
  const older = new Date('2026-07-20T08:00:00Z');
  const at = (hour: number) =>
    new Date(`2026-07-20T${String(hour).padStart(2, '0')}:00:00Z`);
  const links = linkMap([
    ['X', { clusterId: 'K', confidence: 0.9 }],
    ['Z', { clusterId: 'K', confidence: 0.9 }],
  ]);
  const clusters = clusterMap([
    ['K', { clusterSize: 2, stableClusterId: 's-K' }],
  ]);

  it('drops a singleton copy of any cluster member before the cap, freeing its slot', () => {
    const articles = [
      article({ _id: 'X', createdAt: older, pubDate: older }),
      article({ _id: 'Z', createdAt: older, pubDate: older }),
      article({
        _id: 'X2',
        story_key: 'X',
        createdAt: at(12),
        pubDate: at(12),
      }),
      article({
        _id: 'Z2',
        story_key: 'Z',
        createdAt: at(11),
        pubDate: at(11),
      }),
      article({ _id: 'W', createdAt: at(10), pubDate: at(10) }),
    ];

    const result = buildScopeEdition('GLOBAL', articles, links, clusters, 2);

    expect(result.map((e) => e.clusterId ?? e.articleId)).toEqual(['K', 'W']);
    expect(result.map((e) => e.rank)).toEqual([0, 1]);
  });

  it('keeps only the newest of two singletons sharing a key', () => {
    const articles = [
      article({ _id: 'A1', story_key: 'S', createdAt: at(9), pubDate: at(9) }),
      article({
        _id: 'A2',
        story_key: 'S',
        createdAt: at(10),
        pubDate: at(10),
      }),
      article({ _id: 'S', createdAt: at(8), pubDate: at(8) }),
      article({ _id: 'B', story_key: null, createdAt: at(7), pubDate: at(7) }),
    ];

    const result = buildScopeEdition(
      'GLOBAL',
      articles,
      linkMap([]),
      clusterMap([]),
      100,
    );

    expect(result.map((e) => e.articleId)).toEqual(['A2', 'B']);
  });

  it('never drops a cluster entry on a key match (boundary)', () => {
    const articles = [
      article({ _id: 'X', createdAt: older, pubDate: older }),
      article({ _id: 'Z', createdAt: older, pubDate: older }),
      // K2's only member is a copy of K's member X.
      article({
        _id: 'X3',
        story_key: 'X',
        createdAt: at(12),
        pubDate: at(12),
      }),
    ];
    const twoClusters = new Map(links).set('X3', {
      clusterId: 'K2',
      confidence: 0.9,
    });
    const meta = clusterMap([
      ['K', { clusterSize: 2, stableClusterId: 's-K' }],
      ['K2', { clusterSize: 1, stableClusterId: 's-K2' }],
    ]);

    const result = buildScopeEdition(
      'GLOBAL',
      articles,
      twoClusters,
      meta,
      100,
    );

    expect(result.map((e) => e.clusterId)).toEqual(['K', 'K2']);
  });
});

describe('buildScopeEdition — breadth ranking (GLOBAL scope)', () => {
  /**
   * Build `count` members of `clusterId`, one per (country, publisher) pair
   * described by `spread`, plus the matching source metadata.
   */
  function scenario(
    spread: Array<{
      clusterId: string;
      /** country -> how many DISTINCT publishers in it cover the story. */
      markets: Record<string, number>;
      /** Extra feeds per publisher (same publisher, several sources). */
      feedsPerPublisher?: number;
    }>,
  ): {
    articles: HeadlineArticleInput[];
    links: Map<string, HeadlineLinkInput>;
    clusters: Map<string, HeadlineClusterInput>;
    sourceMeta: Map<string, HeadlineSourceMeta>;
  } {
    const articles: HeadlineArticleInput[] = [];
    const links = new Map<string, HeadlineLinkInput>();
    const clusters = new Map<string, HeadlineClusterInput>();
    const sourceMeta = new Map<string, HeadlineSourceMeta>();

    for (const { clusterId, markets, feedsPerPublisher = 1 } of spread) {
      let members = 0;
      for (const [country, publisherCount] of Object.entries(markets)) {
        for (let p = 0; p < publisherCount; p++) {
          const publisherKey = `pub-${country}-${p}`;
          for (let f = 0; f < feedsPerPublisher; f++) {
            const sourceId = `src-${country}-${p}-${f}`;
            const articleId = `${clusterId}-${country}-${p}-${f}`;
            sourceMeta.set(sourceId, { country, publisherKey });
            articles.push(
              article({ _id: articleId, publicationSourceId: sourceId }),
            );
            links.set(articleId, { clusterId, confidence: 0.5 });
            members++;
          }
        }
      }
      clusters.set(clusterId, { clusterSize: members, stableClusterId: null });
    }

    return { articles, links, clusters, sourceMeta };
  }

  const breadthOn = (sourceMeta: Map<string, HeadlineSourceMeta>) => ({
    sourceMeta,
    breadthRanking: true,
  });

  it('ranks a story covered in many markets above a bigger single-market story', () => {
    // This is the production failure: an India-only story with far more
    // articles outranked a story covered in 20+ countries.
    const { articles, links, clusters, sourceMeta } = scenario([
      { clusterId: 'cl-one-market', markets: { IND: 50 } },
      {
        clusterId: 'cl-many-markets',
        markets: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [`C${i}`, 1]),
        ),
      },
    ]);

    const result = buildScopeEdition(
      GLOBAL_SCOPE_KEY,
      articles,
      links,
      clusters,
      100,
      breadthOn(sourceMeta),
    );

    expect(result[0].clusterId).toBe('cl-many-markets');
    expect(result[0].marketCount).toBe(10);
    // 10 markets x perMarket(1)=1.0 vs one market capped at C_MAX.
    expect(result[0].breadthScore).toBeCloseTo(10);
    expect(result[1].breadthScore).toBeCloseTo(HEADLINE_GLOBAL_MARKET_CAP);
    // ...even though the single-market story has 5x the articles.
    expect(result[1].inScopeCount).toBe(50);
  });

  it('caps a single market so it can never outweigh C_MAX other markets', () => {
    const { articles, links, clusters, sourceMeta } = scenario([
      { clusterId: 'cl-huge', markets: { IND: 300 } },
      { clusterId: 'cl-modest', markets: { IND: 20 } },
    ]);

    const result = buildScopeEdition(
      GLOBAL_SCOPE_KEY,
      articles,
      links,
      clusters,
      100,
      breadthOn(sourceMeta),
    );

    // Both saturate the cap; the raw-count tie-break then orders them.
    for (const entry of result) {
      expect(entry.breadthScore).toBeCloseTo(HEADLINE_GLOBAL_MARKET_CAP);
    }
    expect(result[0].clusterId).toBe('cl-huge');
  });

  it('counts one publisher as one voice however many feeds it runs', () => {
    const { articles, links, clusters, sourceMeta } = scenario([
      // One publisher, eight regional feeds all carrying the same story.
      {
        clusterId: 'cl-one-publisher',
        markets: { IND: 1 },
        feedsPerPublisher: 8,
      },
      // Two genuinely independent publishers in one market.
      { clusterId: 'cl-two-publishers', markets: { IND: 2 } },
    ]);

    const result = buildScopeEdition(
      GLOBAL_SCOPE_KEY,
      articles,
      links,
      clusters,
      100,
      breadthOn(sourceMeta),
    );

    const onePublisher = result.find((e) => e.clusterId === 'cl-one-publisher');
    const twoPublishers = result.find(
      (e) => e.clusterId === 'cl-two-publishers',
    );
    // 8 articles, but n_c = 1 → perMarket(1) = 1.0.
    expect(onePublisher?.inScopeCount).toBe(8);
    expect(onePublisher?.breadthScore).toBeCloseTo(1);
    expect(twoPublishers?.breadthScore).toBeCloseTo(1 + Math.log(2));
    expect(result[0].clusterId).toBe('cl-two-publishers');
  });

  it('treats every wire/international source as a single market', () => {
    const { articles, links, clusters, sourceMeta } = scenario([
      // 30 distinct wire publishers, all carrying country_code 'GLOBAL'.
      { clusterId: 'cl-wire-only', markets: { [WIRE_COUNTRY_CODE]: 30 } },
      {
        clusterId: 'cl-five-countries',
        markets: { A: 1, B: 1, C: 1, D: 1, E: 1 },
      },
    ]);

    const result = buildScopeEdition(
      GLOBAL_SCOPE_KEY,
      articles,
      links,
      clusters,
      100,
      breadthOn(sourceMeta),
    );

    const wire = result.find((e) => e.clusterId === 'cl-wire-only');
    expect(wire?.marketCount).toBe(1);
    expect(wire?.breadthScore).toBeCloseTo(HEADLINE_GLOBAL_MARKET_CAP);
    // Five real countries (5.0) beat the capped single wire market (4.0).
    expect(result[0].clusterId).toBe('cl-five-countries');
  });

  it('leaves the ordering untouched when the flag is off', () => {
    const { articles, links, clusters, sourceMeta } = scenario([
      { clusterId: 'cl-one-market', markets: { IND: 50 } },
      {
        clusterId: 'cl-many-markets',
        markets: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [`C${i}`, 1]),
        ),
      },
    ]);

    const legacy = buildScopeEdition(
      GLOBAL_SCOPE_KEY,
      articles,
      links,
      clusters,
      100,
    );
    const flagOff = buildScopeEdition(
      GLOBAL_SCOPE_KEY,
      articles,
      links,
      clusters,
      100,
      { sourceMeta, breadthRanking: false },
    );

    // Same order as before the feature existed: raw count wins.
    expect(legacy.map((e) => e.clusterId)).toEqual([
      'cl-one-market',
      'cl-many-markets',
    ]);
    expect(flagOff.map((e) => e.clusterId)).toEqual(
      legacy.map((e) => e.clusterId),
    );
    // The scores are still computed for observability, just not ranked on.
    expect(flagOff[0].breadthScore).toBeDefined();
    expect(legacy[0].breadthScore).toBeUndefined();
  });

  it('can demote wire-syndication spread via the solo-market weight', () => {
    // The two shapes are deliberately close, and telling them apart is the
    // whole job of soloMarketWeight:
    //  - syndicated: one lone outlet in each of 18 countries (the signature of
    //    a single agency dispatch everyone reprinted),
    //  - reported: 8 countries where several independent newsrooms each
    //    staffed the story.
    const { articles, links, clusters, sourceMeta } = scenario([
      {
        clusterId: 'cl-syndicated',
        markets: Object.fromEntries(
          Array.from({ length: 18 }, (_, i) => [`S${i}`, 1]),
        ),
      },
      {
        clusterId: 'cl-reported',
        markets: Object.fromEntries(
          Array.from({ length: 8 }, (_, i) => [`R${i}`, 4]),
        ),
      },
    ]);

    // At the default weight of 1.0, sheer spread wins: 18.0 vs 8*(1+ln4)=19.1
    // is close, and a couple more countries would flip it.
    const neutral = buildScopeEdition(
      GLOBAL_SCOPE_KEY,
      articles,
      links,
      clusters,
      100,
      breadthOn(sourceMeta),
    );
    expect(
      neutral.find((e) => e.clusterId === 'cl-syndicated')?.breadthScore,
    ).toBeCloseTo(18);

    // Halving a lone outlet's worth costs the syndicated story 9.0 and the
    // reported one only 4.0 — depth per market is what survives the dial.
    const damped = buildScopeEdition(
      GLOBAL_SCOPE_KEY,
      articles,
      links,
      clusters,
      100,
      { ...breadthOn(sourceMeta), soloMarketWeight: 0.5 },
    );
    expect(
      damped.find((e) => e.clusterId === 'cl-syndicated')?.breadthScore,
    ).toBeCloseTo(9);
    expect(damped[0].clusterId).toBe('cl-reported');
  });

  it('never applies breadth to a country scope, flag on or off', () => {
    const { articles, links, clusters, sourceMeta } = scenario([
      { clusterId: 'cl-one-market', markets: { IND: 50 } },
      {
        clusterId: 'cl-many-markets',
        markets: Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [`C${i}`, 1]),
        ),
      },
    ]);

    const countryScope = buildScopeEdition(
      'IND',
      articles,
      links,
      clusters,
      100,
      breadthOn(sourceMeta),
    );

    // Local salience still leads inside a country edition — which is why an
    // Indian reader keeps the big Indian story at the top of their own feed.
    expect(countryScope[0].clusterId).toBe('cl-one-market');
  });
});
