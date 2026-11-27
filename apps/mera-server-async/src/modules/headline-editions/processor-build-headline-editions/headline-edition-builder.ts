/**
 * Pure headline-edition builder — NO IO. Turns one reader view's in-scope
 * articles (plus the run's cluster links + cluster metadata) into an ordered,
 * cluster-deduplicated list of edition entries.
 *
 * Kept side-effect-free so the ranking/representative logic is exhaustively
 * unit-testable with shuffled input and so the service layer owns all Mongo IO.
 */

/** Default cap on entries per edition (overridable via ConfigService). */
// 1000 ran the prod worker out of heap together with the whole-pool publisher count; raise it
// through config only after measuring the build and the readers that load a whole list.
export const HEADLINE_EDITION_MAX_ENTRIES = 200;

/**
 * Article pool (hours) the build streams: 48h is the article TTL, so this is
 * everything Mera holds. The service builds one ranked list per reader view
 * (`HEADLINE_VIEW_WINDOWS_HOURS`) by passing only that view's articles here.
 */
export const HEADLINE_EDITION_WINDOW_HOURS = 48;

/**
 * The reader views built every run ("most covered in the last N hours"). The
 * 24h list is the edition's `entries`; the others go in `views`. Must match
 * `HEADLINE_VIEW_WINDOWS_HOURS` in libs/mera-news-core headline-window.ts,
 * which the resolver validates against (async does not import news-core).
 */
export const HEADLINE_BUILD_VIEWS_HOURS = [6, 12, 24, 48] as const;
export const HEADLINE_ENTRIES_VIEW_HOURS = 24;

/** Sentinel scope covering the whole corpus (all countries). */
export const GLOBAL_SCOPE_KEY = 'GLOBAL';

/**
 * `country_code` used by wire services and international outlets, which is the
 * SAME literal as the global scope sentinel. They therefore get no country
 * edition of their own — they are one "market" inside the global one.
 */
export const WIRE_COUNTRY_CODE = GLOBAL_SCOPE_KEY;

/**
 * Default ceiling on a single market's contribution to `breadthScore`
 * (≈ 20 publishers). Caps how much any one country can be worth relative to
 * others: at 4.0 a single market can never outweigh four other markets.
 */
export const HEADLINE_GLOBAL_MARKET_CAP = 4.0;

/**
 * Value of a market where exactly ONE publisher carried the story — the
 * intercept of `perMarket`. 1.0 keeps a lone outlet worth a full market.
 *
 * This is the dial for wire syndication: a single agency dispatch reprinted by
 * one outlet in each of 20 countries is 20 lone-publisher markets, and looks
 * identical to a real global story unless a lone outlet is worth less than a
 * market several independent newsrooms chose to staff. Lower it toward ~0.5 if
 * the comparison output shows syndicated filler climbing.
 */
export const HEADLINE_GLOBAL_SOLO_MARKET_WEIGHT = 1.0;

/** Where a scope's article came from, for the breadth score. */
export interface HeadlineSourceMeta {
  /** publication-source `country_code`. */
  country: string;
  /**
   * `newsPublisherId` when set, else the publication-source id — so one
   * publisher's many regional feeds count as a single voice.
   */
  publisherKey: string;
}

/** Optional breadth-ranking inputs. Omit for the legacy count-only ranking. */
export interface HeadlineRankingOptions {
  /**
   * publicationSourceId -> {country, publisherKey}. When absent, breadth is not
   * computed at all and the ranking is exactly the legacy one.
   */
  sourceMeta?: Map<string, HeadlineSourceMeta>;
  /**
   * Rank the GLOBAL scope by `breadthScore` instead of raw `inScopeCount`.
   * Ignored for country scopes, which always keep the legacy comparator.
   */
  breadthRanking?: boolean;
  /** Per-market contribution cap. Defaults to HEADLINE_GLOBAL_MARKET_CAP. */
  marketCap?: number;
  /**
   * Worth of a one-publisher market. Defaults to
   * HEADLINE_GLOBAL_SOLO_MARKET_WEIGHT (1.0 — no damping).
   */
  soloMarketWeight?: number;
  /**
   * publicationSourceId -> the publisher's reading score, for the cards. Kept
   * per source, not per article: the pool holds about half a million articles.
   */
  scoreBySource?: Map<string, number>;
}

/** A lean in-scope article the builder ranks. `_id` is the article id (hex). */
export interface HeadlineArticleInput {
  _id: string;
  publicationSourceId: string;
  createdAt: Date;
  pubDate: Date;
  image_url?: string | null;
  /** The article's story (seed article id, hex); null or absent when it seeds its own. */
  story_key?: string | null;
  /** Base language tag, interned. Null or absent when unknown. */
  lang?: string | null;
}

/** The article's cluster-article-link for this run (one per article). */
export interface HeadlineLinkInput {
  clusterId: string;
  confidence: number;
}

/** Cluster metadata for a live cluster this run wrote. */
export interface HeadlineClusterInput {
  clusterSize: number;
  stableClusterId: string | null;
}

/** The best article of a story in one language. */
export interface HeadlineCardOutput {
  articleId: string;
  lang: string | null;
  score: number | null;
}

/** One ordered output slot. Ids are hex strings; the service maps to ObjectId. */
export interface HeadlineEntryOutput {
  articleId: string;
  clusterId: string | null;
  stableClusterId: string | null;
  clusterSize: number;
  inScopeCount: number;
  rank: number;
  /** One card per language, in representative order. Always at least one. */
  cards: HeadlineCardOutput[];
  /** Sum of capped per-market contributions. Undefined without `sourceMeta`. */
  breadthScore?: number;
  /** Distinct countries covering the story. Undefined without `sourceMeta`. */
  marketCount?: number;
}

/** Descending numeric comparator. */
function descNum(a: number, b: number): number {
  return b - a;
}

/**
 * One market's contribution to the breadth score: concave in the number of
 * distinct publishers and hard-capped, so a story's *spread across markets*
 * outranks its *depth in one market*.
 *
 * Ranking the global edition by raw article count is really ranking by "which
 * country has the most feeds" — India alone runs ~3x the feeds of the US, so
 * single-market Indian stories crowded out stories covered in 20+ countries.
 * A capped log keeps magnitude meaningful (10 publishers still beat 2) without
 * letting one oversampled market buy the whole front page.
 */
function perMarket(
  publisherCount: number,
  cap: number,
  soloWeight: number,
): number {
  if (publisherCount <= 0) return 0;
  // soloWeight is the intercept: at 1.0 this is the plain 1 + ln(n).
  return Math.min(cap, soloWeight + Math.log(publisherCount));
}

/**
 * Build one scope's ordered, cluster-deduplicated edition entries.
 *
 * An in-scope article is "clustered" only if it has a link whose cluster is one
 * of this run's live clusters (present in `clustersById`); otherwise it is an
 * unclustered singleton. Clusters are emitted first (ranked), singletons after.
 *
 * Cluster ranking, GLOBAL scope with `breadthRanking`: breadthScore desc →
 * inScopeCount desc → clusterSize desc → newest in-scope createdAt desc →
 * clusterId asc. Every country scope, and GLOBAL without the flag, keeps the
 * legacy comparator (inScopeCount first) — local salience is the right signal
 * for a country edition, and breadth is only meaningful across markets.
 * Representative per cluster: hasImage desc → publishedAt desc (newest first,
 * pubDate clamped to createdAt) → _id desc.
 * Singleton tail: createdAt desc → _id desc, minus copies (same `story_key ?? _id`)
 * of any clustered member or of an earlier kept singleton.
 * Each entry carries one card per language (see `buildCards`).
 * Whole list is truncated to `cap`; `rank` mirrors the final index.
 */
export function buildScopeEdition(
  scopeKey: string,
  inScopeArticles: HeadlineArticleInput[],
  linksByArticleId: Map<string, HeadlineLinkInput>,
  clustersById: Map<string, HeadlineClusterInput>,
  cap: number = HEADLINE_EDITION_MAX_ENTRIES,
  options: HeadlineRankingOptions = {},
): HeadlineEntryOutput[] {
  const { sourceMeta } = options;
  const marketCap = options.marketCap ?? HEADLINE_GLOBAL_MARKET_CAP;
  const soloMarketWeight =
    options.soloMarketWeight ?? HEADLINE_GLOBAL_SOLO_MARKET_WEIGHT;
  // Breadth only orders the global edition, and only when we know where each
  // article came from.
  const useBreadth = Boolean(
    options.breadthRanking && sourceMeta && scopeKey === GLOBAL_SCOPE_KEY,
  );
  // Group clustered members by clusterId; collect unclustered singletons.
  const membersByCluster = new Map<string, HeadlineArticleInput[]>();
  const singletons: HeadlineArticleInput[] = [];

  for (const article of inScopeArticles) {
    const link = linksByArticleId.get(article._id);
    if (link && link.clusterId && clustersById.has(link.clusterId)) {
      const members = membersByCluster.get(link.clusterId);
      if (members) {
        members.push(article);
      } else {
        membersByCluster.set(link.clusterId, [article]);
      }
    } else {
      singletons.push(article);
    }
  }

  // Build a cluster entry (representative + ranking signals) per cluster.
  interface ClusterEntry {
    entry: HeadlineEntryOutput;
    inScopeCount: number;
    clusterSize: number;
    newestCreatedAt: number;
    clusterId: string;
    breadthScore: number;
  }

  const clusterEntries: ClusterEntry[] = [];
  for (const [clusterId, members] of membersByCluster) {
    const meta = clustersById.get(clusterId)!;
    const representative = pickRepresentative(members);
    const newestCreatedAt = members.reduce(
      (max, m) => Math.max(max, m.createdAt.getTime()),
      -Infinity,
    );
    const breadth = computeBreadth(
      members,
      sourceMeta,
      marketCap,
      soloMarketWeight,
    );
    clusterEntries.push({
      entry: {
        articleId: representative._id,
        clusterId,
        stableClusterId: meta.stableClusterId ?? null,
        clusterSize: meta.clusterSize ?? 0,
        inScopeCount: members.length,
        rank: 0, // assigned after final ordering
        cards: [], // built after the cap, for kept entries only
        ...breadth,
      },
      inScopeCount: members.length,
      clusterSize: meta.clusterSize ?? 0,
      newestCreatedAt,
      clusterId,
      breadthScore: breadth?.breadthScore ?? 0,
    });
  }

  clusterEntries.sort(
    (a, b) =>
      (useBreadth ? descNum(a.breadthScore, b.breadthScore) : 0) ||
      descNum(a.inScopeCount, b.inScopeCount) ||
      descNum(a.clusterSize, b.clusterSize) ||
      descNum(a.newestCreatedAt, b.newestCreatedAt) ||
      (a.clusterId < b.clusterId ? -1 : a.clusterId > b.clusterId ? 1 : 0),
  );

  // Singletons ordered newest-first (createdAt desc → _id desc).
  const sortedSingletons = [...singletons].sort(
    (a, b) =>
      descNum(a.createdAt.getTime(), b.createdAt.getTime()) ||
      (a._id < b._id ? 1 : a._id > b._id ? -1 : 0),
  );

  // A singleton that is a copy of a clustered member or of an earlier kept
  // singleton is dropped BEFORE the cap, so it frees its slot. Cluster entries
  // are never dropped on a key match: that would merge split stories on a
  // similarity threshold, which was measured and removed.
  const seen = new Set<string>();
  for (const members of membersByCluster.values()) {
    for (const m of members) seen.add(m.story_key ?? m._id);
  }
  const keptSingletons = sortedSingletons.filter((a) => {
    const key = a.story_key ?? a._id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const singletonEntries: HeadlineEntryOutput[] = keptSingletons.map((a) => ({
    articleId: a._id,
    clusterId: null,
    stableClusterId: null,
    clusterSize: 0,
    inScopeCount: 1,
    rank: 0,
    cards: [],
    ...computeBreadth([a], sourceMeta, marketCap, soloMarketWeight),
  }));

  const ordered: HeadlineEntryOutput[] = [
    ...clusterEntries.map((c) => c.entry),
    ...singletonEntries,
  ].slice(0, Math.max(0, cap));

  // rank mirrors the final position. Cards are built only for the entries
  // kept: clusters come first in `ordered`, then singletons in kept order.
  const scoreOf = (a: HeadlineArticleInput): number | null =>
    options.scoreBySource?.get(a.publicationSourceId) ?? null;
  ordered.forEach((entry, index) => {
    entry.rank = index;
    entry.cards = buildCards(
      index < clusterEntries.length
        ? membersByCluster.get(entry.clusterId!)!
        : [keptSingletons[index - clusterEntries.length]],
      scoreOf,
    );
  });

  return ordered;
}

/**
 * Score how widely a story is covered ACROSS markets, from its in-scope members.
 *
 * Members are folded into distinct publishers per country (so one publisher's
 * many regional feeds count as one voice), then each country contributes a
 * capped, concave term. Wire/international sources all share the
 * `WIRE_COUNTRY_CODE` bucket, so they contribute a single capped term between
 * them — they are one market, not one per outlet.
 *
 * Returns `undefined` when no `sourceMeta` was supplied, which leaves both
 * fields off the entry entirely and the ranking exactly as it was.
 */
function computeBreadth(
  members: HeadlineArticleInput[],
  sourceMeta: Map<string, HeadlineSourceMeta> | undefined,
  marketCap: number,
  soloMarketWeight: number,
): { breadthScore: number; marketCount: number } | undefined {
  if (!sourceMeta) return undefined;

  const publishersByMarket = new Map<string, Set<string>>();
  for (const member of members) {
    const meta = sourceMeta.get(member.publicationSourceId);
    // An article whose source we cannot place contributes no breadth, rather
    // than inventing a market for it.
    if (!meta) continue;
    const publishers = publishersByMarket.get(meta.country);
    if (publishers) {
      publishers.add(meta.publisherKey);
    } else {
      publishersByMarket.set(meta.country, new Set([meta.publisherKey]));
    }
  }

  let breadthScore = 0;
  for (const publishers of publishersByMarket.values()) {
    breadthScore += perMarket(publishers.size, marketCap, soloMarketWeight);
  }

  return { breadthScore, marketCount: publishersByMarket.size };
}

/**
 * When an article was published, clamped to when we ingested it: a feed's
 * future (or unparseable) pubDate must not hold a story's card forever.
 */
function publishedAt(a: HeadlineArticleInput): number {
  const pub = a.pubDate.getTime();
  const ingested = a.createdAt.getTime();
  return Number.isNaN(pub) ? ingested : Math.min(pub, ingested);
}

/**
 * Pick a cluster's representative article deterministically, so the card shows
 * the story's latest report: hasImage desc → publishedAt desc → _id desc.
 * An image still wins over recency (an imageless World row has no thumbnail).
 */
function pickRepresentative(
  members: HeadlineArticleInput[],
): HeadlineArticleInput {
  return [...members].sort(compareRepresentative)[0];
}

function compareRepresentative(
  a: HeadlineArticleInput,
  b: HeadlineArticleInput,
): number {
  const aHasImage = a.image_url ? 1 : 0;
  const bHasImage = b.image_url ? 1 : 0;
  if (aHasImage !== bHasImage) return descNum(aHasImage, bHasImage);

  const aPub = publishedAt(a);
  const bPub = publishedAt(b);
  if (aPub !== bPub) return descNum(aPub, bPub);

  // _id desc
  return a._id < b._id ? 1 : a._id > b._id ? -1 : 0;
}

/**
 * One card per language: within a language the highest score wins (an
 * unscored article loses to any scored one, a score of 0 included), ties go to
 * representative order. Cards are returned in the representative order of
 * their articles.
 */
function buildCards(
  members: HeadlineArticleInput[],
  scoreOf: (a: HeadlineArticleInput) => number | null,
): HeadlineCardOutput[] {
  const best = new Map<
    string | null,
    { article: HeadlineArticleInput; score: number | null }
  >();
  for (const m of [...members].sort(compareRepresentative)) {
    const key = m.lang ?? null;
    const score = scoreOf(m);
    const held = best.get(key);
    if (!held || (score ?? -1) > (held.score ?? -1)) {
      best.set(key, { article: m, score });
    }
  }
  return [...best.values()]
    .sort((a, b) => compareRepresentative(a.article, b.article))
    .map(({ article, score }) => ({
      articleId: article._id,
      lang: article.lang ?? null,
      score,
    }));
}
