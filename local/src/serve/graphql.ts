// The full server's GraphQL schema, served from the one-computer store. The
// schema file is a byte copy of the full server's (a test keeps them equal), so
// a pod sees the same contract. Operations the store has no data for answer
// empty where their type allows it, and NOT_IN_LOCAL_MODE otherwise.
import {
  GraphQLError,
  GraphQLList,
  GraphQLNonNull,
  buildSchema,
  execute,
  parse,
  specifiedRules,
  validate,
  type ExecutionResult,
  type GraphQLFieldResolver,
  type GraphQLSchema,
} from 'graphql';
import type { Embedder } from '../embed/embedder.ts';
import type { FeedRow, Store } from '../store/store.ts';
import sdl from '../../schema.gql';
import { MAX_QUERY_FIELDS, queryLimitsRule } from './query-limits.ts';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_DEPTH, MAX_SEARCH_PAGE_LIMIT, personaWindowStart, searchArticles, topicArticles } from './retrieval.ts';

export const MAX_QUERY_DEPTH = 12;
const MAX_PAGE = 100;

export interface Context {
  store: Store;
  embedder: Embedder;
}

const notHere = (field: string) =>
  new GraphQLError(`The one-computer setup does not answer ${field}: it keeps no data for it.`, {
    extensions: { code: 'NOT_IN_LOCAL_MODE' },
  });

interface ArticleFull {
  id: string;
  feed_id: string;
  article_url: string;
  title: string;
  description: string | null;
  image_url: string | null;
  language_code: string | null;
  pub_date: string;
  created_at: string;
  story_key: string;
}

const publicationSource = (f: FeedRow & { created_at?: string; updated_at?: string }) => ({
  _id: f.id,
  category: '',
  consecutive_fetch_failures: f.consecutive_failures,
  country_code: f.country_code ?? '',
  createdAt: f.created_at,
  detected_language_code: f.feed_language_code,
  feed_language_code: f.feed_language_code,
  feed_url: f.feed_url,
  gated: false,
  is_active: f.is_active === 1,
  last_fetch_error: f.last_fetch_error,
  last_fetch_status: f.last_fetch_status,
  last_fetched_at: f.last_fetch_at,
  newsPublisherId: f.publisher_id,
  publication_name: f.publication_name || new URL(f.feed_url).hostname,
  publication_url: f.publication_url,
  type: 'rss-feed',
  updatedAt: f.updated_at,
});

function feedById(store: Store, id: string) {
  return store.db.prepare('SELECT * FROM feeds WHERE id = ?').get(id) as (FeedRow & { created_at: string; updated_at: string }) | undefined;
}

function fullArticles(store: Store, ids: string[]): ArticleFull[] {
  const get = store.db.prepare('SELECT id, feed_id, article_url, title, description, image_url, language_code, pub_date, created_at, story_key FROM articles WHERE id = ?');
  return ids.flatMap((id) => {
    const row = get.get(id) as ArticleFull | undefined;
    return row ? [row] : [];
  });
}

/** One article as `ArticleWithClusters`: no translation, so `title_en` is the title; no clusters. */
function withClusters(store: Store, a: ArticleFull) {
  const feed = feedById(store, a.feed_id);
  return {
    _id: a.id,
    article_url: a.article_url,
    clusters: [],
    country_code: feed?.country_code ?? null,
    description_en: a.description,
    image_url: a.image_url,
    language_code: a.language_code ?? feed?.feed_language_code ?? null,
    maxClusterSize: null,
    pubDate: a.pub_date,
    publication_name: feed ? feed.publication_name || new URL(feed.feed_url).hostname : null,
    story_key: a.story_key,
    title: a.title,
    title_en: a.title,
    vector_sidecar_packed: null,
  };
}

function newsArticle(store: Store, a: ArticleFull) {
  const feed = feedById(store, a.feed_id);
  return {
    _id: a.id,
    article_url: a.article_url,
    createdAt: a.created_at,
    description: a.description ?? '',
    description_en: a.description,
    image_url: a.image_url,
    original_language_code: a.language_code ?? feed?.feed_language_code ?? null,
    pubDate: a.pub_date,
    publicationSource: feed ? publicationSource(feed) : null,
    publicationSourceId: a.feed_id,
    source_uri: feed?.feed_url ?? '',
    title: a.title,
    title_en: a.title,
    type: 'rss-feed',
    updatedAt: a.created_at,
  };
}

const encodeCursor = (pubDate: string, id: string) => Buffer.from(`${pubDate}|${id}`).toString('base64url');
function decodeCursor(cursor: string): [string, string] {
  const [pubDate, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!pubDate || !id || Number.isNaN(Date.parse(pubDate))) {
    throw new GraphQLError('The page cursor is not one this server gave out.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
  return [pubDate, id];
}
const page = (first: number | null | undefined) => Math.min(Math.max(first ?? 20, 1), MAX_PAGE);

/**
 * The full server's search page cursor shape, `{ asOf, from, offset }`.
 * shortcut: only `offset` is read here, the window is not frozen, because the store
 * changes only when an ingest runs; freeze it if pages repeat across ingests.
 */
const encodeSearchCursor = (asOf: string, offset: number) =>
  Buffer.from(JSON.stringify({ asOf, from: new Date(Date.parse(asOf) - 48 * 3600_000).toISOString(), offset })).toString('base64');
function decodeSearchCursor(cursor: string): { asOf: string; offset: number } {
  try {
    const { asOf, from, offset } = JSON.parse(Buffer.from(cursor, 'base64').toString());
    if (typeof asOf === 'string' && typeof from === 'string' && !Number.isNaN(Date.parse(asOf)) && Number.isInteger(offset) && offset >= 0) return { asOf, offset };
  } catch {
    // Refused below.
  }
  throw new GraphQLError('after is not a valid cursor', { extensions: { code: 'BAD_USER_INPUT' } });
}

const searchHit = (h: Awaited<ReturnType<typeof searchArticles>>['hits'][number]) => ({
  _id: h.id,
  country_code: h.countryCode,
  image_url: h.imageUrl,
  pubDate: h.pubDate,
  publication_name: h.publicationName,
  score: h.score,
  title_en: h.title,
});

type Resolver = GraphQLFieldResolver<unknown, Context, any>;

const RESOLVERS: Record<string, Resolver> = {
  async searchNews(_p, { query, limit }, { store, embedder }) {
    const { hits } = await searchArticles(store, embedder, query, { limit: limit ?? DEFAULT_SEARCH_LIMIT });
    return hits.map(searchHit);
  },

  async searchNewsPage(_p, { query, limit, after }, { store, embedder }) {
    const { asOf, offset } = after ? decodeSearchCursor(after) : { asOf: new Date().toISOString(), offset: 0 };
    const size = Math.min(Math.min(Math.max(limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_PAGE_LIMIT), MAX_SEARCH_DEPTH - offset);
    if (size <= 0) return { hits: [], nextCursor: null };
    const { hits, more } = await searchArticles(store, embedder, query, { limit: size, offset, maxLimit: MAX_SEARCH_PAGE_LIMIT });
    const served = offset + hits.length;
    return { hits: hits.map(searchHit), nextCursor: more && served < MAX_SEARCH_DEPTH ? encodeSearchCursor(asOf, served) : null };
  },

  articlesForTopicsByIds(_p, { articleIds }, { store }) {
    return { articles: fullArticles(store, articleIds).map((a) => withClusters(store, a)), dailyLimitReached: false, resetAt: null };
  },

  articlesForStories(_p, { articleIds }, { store }) {
    return { articles: fullArticles(store, articleIds).map((a) => withClusters(store, a)), dailyLimitReached: false, resetAt: null };
  },

  // `order` is accepted and both orders answer newest first: the store keeps no clusters to rank by.
  articlesForCountry(_p, { countryCode, first, after }, { store }) {
    const size = page(first);
    const all = !countryCode || countryCode === 'GLOBAL';
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (!all) {
      where.push('f.country_code = ?');
      args.push(countryCode);
    }
    if (after) {
      const [pubDate, id] = decodeCursor(after);
      where.push('(a.pub_date < ? OR (a.pub_date = ? AND a.id < ?))');
      args.push(pubDate, pubDate, id);
    }
    const rows = store.db
      .prepare(
        `SELECT a.id FROM articles a JOIN feeds f ON f.id = a.feed_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY a.pub_date DESC, a.id DESC LIMIT ?`,
      )
      .all(...args, size + 1) as { id: string }[];
    const articles = fullArticles(store, rows.slice(0, size).map((r) => r.id));
    const last = articles.at(-1);
    return {
      articles: articles.map((a) => newsArticle(store, a)),
      itemCursors: articles.map((a) => encodeCursor(a.pub_date, a.id)),
      pageInfo: { endCursor: last ? encodeCursor(last.pub_date, last.id) : null, hasNextPage: rows.length > size, pageSize: articles.length },
    };
  },

  async articleIdsForPersona(_p, { query }, { store, embedder }) {
    const since = personaWindowStart(store);
    const topicResults = [];
    for (const topic of query.topics as { text: string; limit?: number | null }[]) {
      const hits = await topicArticles(store, embedder, topic.text, { limit: topic.limit ?? query.limitPerTopic, since });
      topicResults.push({
        topicText: topic.text,
        articleIds: hits.map((h) => h.id),
        matchMeta: hits.map((h) => ({ articleId: h.id, vectorScore: null, textScore: null, stableClusterId: null })),
        nextCursor: null,
        hasNextPage: false,
      });
    }
    const headlineResults = ((query.topHeadlines?.scopes ?? []) as { scope: string; countryCode?: string | null }[]).map((s) => ({
      scope: s.scope,
      countryCode: s.scope === 'COUNTRY' ? (s.countryCode ?? null) : null,
      articleIds: [],
      clusterSizes: [],
      stableClusterIds: [],
    }));
    return { topicResults, headlineResults };
  },

  newsServerStatus(_p, _a, { store }) {
    const last = store.db.prepare('SELECT MAX(created_at) AS at FROM articles').get() as { at: string | null };
    const model = store.embeddingModel();
    return {
      embeddingModel: model?.id ?? null,
      headlineEditionsBuilt: false,
      lastArticleAt: last.at,
      lastClusteringAt: null,
      lastTopicLinkAt: null,
      placesSeeded: false,
      textIndexState: 'ready',
      vectorIndexState: model ? 'ready' : 'missing',
    };
  },

  allCountries(_p, _a, { store }) {
    return (store.db.prepare('SELECT DISTINCT country_code FROM feeds WHERE country_code IS NOT NULL ORDER BY country_code').all() as { country_code: string }[]).map(
      (r) => r.country_code,
    );
  },

  recentArticleCount(_p, { since }, { store }) {
    const last = store.lastIngestAt();
    const from = since ? new Date(since).toISOString() : last ? new Date(Date.parse(last) - 24 * 3600_000).toISOString() : null;
    if (!from) return 0;
    return (store.db.prepare('SELECT COUNT(*) AS n FROM articles WHERE created_at >= ?').get(from) as { n: number }).n;
  },

  publicationSourcesForNewsPublisher(_p, { publisherId }, { store }) {
    const feeds = store.db.prepare('SELECT * FROM feeds WHERE publisher_id = ? ORDER BY publication_name, feed_url').all(publisherId) as unknown as (FeedRow & { created_at: string; updated_at: string })[];
    return { publicationSources: feeds.map(publicationSource) };
  },

  searchPublishers(_p, { query, first, after }, { store }) {
    const size = page(first);
    const offset = after ? Number(Buffer.from(after, 'base64url').toString()) || 0 : 0;
    const rows = store.db
      .prepare("SELECT * FROM publishers WHERE name LIKE ? ESCAPE '\\' ORDER BY name, id LIMIT ? OFFSET ?")
      .all(`%${String(query).replace(/[\\%_]/g, (c) => `\\${c}`)}%`, size + 1, offset) as { id: string; name: string; country_code: string | null; website_url: string | null }[];
    const publishers = rows.slice(0, size).map((p) => ({
      _id: p.id,
      country_code: p.country_code ?? '',
      country_name: null,
      matchingSources: (store.db.prepare('SELECT * FROM feeds WHERE publisher_id = ?').all(p.id) as unknown as (FeedRow & { created_at: string; updated_at: string })[]).map(publicationSource),
      name: p.name,
      subscription_uri: null,
      website_url: p.website_url,
    }));
    return {
      publishers,
      pageInfo: { endCursor: rows.length > size ? Buffer.from(String(offset + size)).toString('base64url') : null, hasNextPage: rows.length > size, pageSize: publishers.length },
    };
  },

  // A non-null object with nothing in it: the setup builds no headline lists.
  topHeadlinesForCountry() {
    return { articles: [], editionBuiltAt: null, headlines: [], pageInfo: { endCursor: null, hasNextPage: false, pageSize: 0 } };
  },
};

/** The schema with every root field resolved: by the store, empty, or NOT_IN_LOCAL_MODE. */
export function buildLocalSchema(): GraphQLSchema {
  const schema = buildSchema(sdl);
  for (const root of [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]) {
    if (!root) continue;
    for (const [name, field] of Object.entries(root.getFields())) {
      const own = root === schema.getQueryType() ? RESOLVERS[name] : undefined;
      if (own) {
        field.resolve = own;
        continue;
      }
      const inner = field.type instanceof GraphQLNonNull ? field.type.ofType : field.type;
      if (inner instanceof GraphQLList) field.resolve = () => [];
      else if (!(field.type instanceof GraphQLNonNull)) field.resolve = () => null;
      else field.resolve = () => {
        throw notHere(name);
      };
    }
  }
  return schema;
}

export const LOCAL_RESOLVERS = Object.keys(RESOLVERS);

/** One GraphQL request, validated with the full server's limits. Unexpected errors hide their message. */
export async function runQuery(
  schema: GraphQLSchema,
  context: Context,
  body: { query?: unknown; variables?: unknown; operationName?: unknown },
): Promise<{ status: number; result: ExecutionResult }> {
  if (typeof body.query !== 'string') {
    return { status: 400, result: { errors: [new GraphQLError('The request has no query.', { extensions: { code: 'BAD_REQUEST' } })] } };
  }
  let document;
  try {
    document = parse(body.query);
  } catch (error) {
    return { status: 400, result: { errors: [new GraphQLError((error as Error).message, { extensions: { code: 'GRAPHQL_PARSE_FAILED' } })] } };
  }
  const invalid = validate(schema, document, [...specifiedRules, queryLimitsRule(MAX_QUERY_DEPTH, MAX_QUERY_FIELDS)]);
  if (invalid.length > 0) {
    return {
      status: 400,
      result: { errors: invalid.map((e) => new GraphQLError(e.message, { nodes: e.nodes, extensions: { code: (e.extensions?.code as string) ?? 'GRAPHQL_VALIDATION_FAILED' } })) },
    };
  }
  const result = await execute({
    schema,
    document,
    contextValue: context,
    variableValues: (body.variables as Record<string, unknown> | undefined) ?? undefined,
    operationName: typeof body.operationName === 'string' ? body.operationName : undefined,
  });
  if (result.errors) {
    result.errors = result.errors.map((e) => {
      if (e.extensions?.code) return e;
      // No cause: graphql's own refusal of the request (a missing variable and the like).
      const internal = e.originalError !== undefined && !(e.originalError instanceof GraphQLError);
      return new GraphQLError(internal ? 'Internal server error' : e.message, {
        nodes: e.nodes,
        path: e.path,
        extensions: { code: internal ? 'INTERNAL_SERVER_ERROR' : 'BAD_USER_INPUT' },
      });
    });
  }
  return { status: 200, result };
}
