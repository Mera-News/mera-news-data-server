/**
 * Probe: execute every document the news client's adapter can send against a
 * RUNNING `mera-server-news-api`, and assert on the parsed payload.
 *
 * Run with:
 *   NEWS_API_URL=http://127.0.0.1:3002/graphql \
 *   MERA_NEWS_API_KEY=<key> \
 *   npx ts-node scripts/news-api-probe.ts [--dump <file.json>]
 *
 * `--dump` also writes every request (operation, variables) and its `data` to
 * a JSON file, so two services on the same database can be diffed.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY NOT "IT RETURNED 200"
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * A GraphQL service answers 200 for almost everything it gets wrong. A document
 * whose every field resolves to null is a 200. A document that returns
 * `errors` is a 200. The client's adapter turns any `errors` response into the
 * degraded value for that method and logs only the error COUNT, so the symptom
 * of a broken contract on its side is a thin or empty feed with no recorded
 * cause. Checking the status code here would reproduce exactly that blindness.
 *
 * So every check below reads the PARSED body: `errors` must be absent, and the
 * payload must carry the shape the adapter maps. `_id` and `article_url` are
 * asserted non-empty on article rows because those two are what make a row
 * usable at all — a row without them renders as a blank card.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE VARIABLES ARE DISCOVERED, NOT HARDCODED
 *
 * Seven of the eleven documents need a real id: an article, a publisher, a
 * publication source, a country code. Hardcoding any of them pins this probe to
 * one database, and it is meant to run against a local scratch Mongo AND
 * against staging without an edit. So it walks the corpus first — countries,
 * then publishers, then articles — and feeds each answer into the next
 * document. A probe that cannot find a seed says so and exits non-zero rather
 * than reporting a pass on an empty corpus, which is the failure this ordering
 * is designed to make loud.
 *
 * READ-ONLY. Every document here is a query; none of them writes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { writeFileSync } from 'fs';
import { config } from 'dotenv';
import { ADAPTER_DOCUMENTS } from '../apps/mera-server-news-api/src/modules/adapter-documents';

config();

const ENDPOINT = process.env.NEWS_API_URL ?? 'http://127.0.0.1:3002/graphql';
const API_KEY = process.env.MERA_NEWS_API_KEY ?? '';
const dumpFlag = process.argv.indexOf('--dump');
const DUMP_PATH = dumpFlag === -1 ? undefined : process.argv[dumpFlag + 1];
const dumped: {
  operationName: string;
  variables: Record<string, unknown>;
  data: unknown;
}[] = [];

interface GraphQLBody<T> {
  data?: T;
  errors?: { message: string }[];
}

class ProbeFailure extends Error {}

/**
 * One request. Throws on a transport failure, on a GraphQL `errors` array, and
 * on a missing `data` — all three are the same thing to the adapter (a
 * degraded answer) and must be the same thing here.
 */
async function send<T>(
  operationName: string,
  variables: Record<string, unknown>,
  apiKey: string = API_KEY,
): Promise<T> {
  const query = ADAPTER_DOCUMENTS[operationName];
  if (!query) {
    throw new ProbeFailure(`No transcribed document named ${operationName}`);
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ query, variables, operationName }),
  });

  const body = (await response.json()) as GraphQLBody<T>;
  dumped.push({ operationName, variables, data: body.data ?? null });
  if (body.errors?.length) {
    throw new ProbeFailure(
      `${operationName} returned ${body.errors.length} GraphQL error(s): ` +
        body.errors.map((e) => e.message).join(' | '),
    );
  }
  if (!body.data) {
    throw new ProbeFailure(`${operationName} returned no data`);
  }
  return body.data;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ProbeFailure(message);
}

/** The two fields without which an article row cannot be rendered at all. */
function assertUsableArticle(article: unknown, where: string): void {
  const row = article as { _id?: unknown; article_url?: unknown } | null;
  assert(row, `${where}: article row is null`);
  assert(
    typeof row._id === 'string' && row._id.length > 0,
    `${where}: article has no _id`,
  );
  assert(
    typeof row.article_url === 'string' && row.article_url.length > 0,
    `${where}: article has no article_url`,
  );
}

interface Seeds {
  countryCode: string;
  articleId: string;
  newsPublisherId: string;
  publicationSourceId: string;
}

const results: { name: string; detail: string }[] = [];
const failures: { name: string; error: string }[] = [];

async function check(name: string, run: () => Promise<string>): Promise<void> {
  try {
    const detail = await run();
    results.push({ name, detail });
    console.log(`  PASS  ${name.padEnd(30)} ${detail}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ name, error: message });
    console.log(`  FAIL  ${name.padEnd(30)} ${message}`);
  }
}

/**
 * The key guard, checked FIRST and on its own.
 *
 * If this service ever answers without a valid key, every other result in this
 * run is meaningless — they would all pass against an unauthenticated service
 * just as well. `main.ts` refuses to boot without the key, so the case being
 * checked here is a WRONG key rather than an absent one.
 */
async function probeApiKeyGuard(): Promise<void> {
  await check('x-api-key guard', async () => {
    let rejected = false;
    try {
      await send('MeraAllCountries', {}, 'definitely-not-the-key');
    } catch {
      rejected = true;
    }
    assert(
      rejected,
      'a wrong x-api-key was ACCEPTED — refusing to trust this run',
    );

    // And the right key must still work, or "rejected" above proves nothing.
    const data = await send<{ allCountries: string[] }>('MeraAllCountries', {});
    assert(Array.isArray(data.allCountries), 'allCountries is not an array');
    return 'wrong key refused, correct key accepted';
  });

  if (failures.length > 0) {
    console.error('\nAborting: the authentication check did not pass.');
    process.exit(1);
  }
}

/** Walks the corpus for one real value of each id the documents need. */
async function discoverSeeds(): Promise<Seeds> {
  const countries = await send<{ allCountries: string[] }>(
    'MeraAllCountries',
    {},
  );
  // `GLOBAL` is a sentinel for wire/international sources, not a market, so it
  // is a poor seed for the country-scoped documents.
  const countryCode =
    countries.allCountries.find((c) => c && c !== 'GLOBAL') ??
    countries.allCountries[0];
  assert(countryCode, 'corpus has no countries — cannot seed the probe');

  const publishers = await send<{
    newsPublishers: {
      newsPublishers: {
        _id: string;
        publicationSources: { _id: string }[];
      }[];
    };
  }>('MeraNewsPublishers', { countryCode, first: 5 });

  const publisher = publishers.newsPublishers.newsPublishers.find(
    (p) => p.publicationSources.length > 0,
  );
  assert(publisher, `no publisher with a source in ${countryCode}`);

  const articles = await send<{
    articlesForCountry: { articles: { _id: string }[] };
  }>('MeraArticlesForCountry', { countryCode, first: 5 });

  const articleId = articles.articlesForCountry.articles[0]?._id;
  assert(articleId, `no articles in ${countryCode} — cannot seed the probe`);

  return {
    countryCode,
    articleId,
    newsPublisherId: publisher._id,
    publicationSourceId: publisher.publicationSources[0]._id,
  };
}

async function main(): Promise<void> {
  assert(
    API_KEY,
    'MERA_NEWS_API_KEY is not set. The service refuses to boot without it, ' +
      'so the probe refuses to run without it.',
  );

  console.log(`news-api probe -> ${ENDPOINT}\n`);
  await probeApiKeyGuard();

  const seeds = await discoverSeeds();
  console.log(
    `\nSeeds: country=${seeds.countryCode} article=${seeds.articleId} ` +
      `publisher=${seeds.newsPublisherId} source=${seeds.publicationSourceId}\n`,
  );

  await check('MeraAllCountries', async () => {
    const d = await send<{ allCountries: string[] }>('MeraAllCountries', {});
    assert(d.allCountries.length > 0, 'allCountries is empty');
    assert(
      d.allCountries.every((c) => typeof c === 'string'),
      'allCountries holds a non-string',
    );
    return `${d.allCountries.length} countries`;
  });

  await check('MeraRecentArticleCount', async () => {
    // `since` is CLAMPED to a 48h floor on purpose: `news-article` is swept at
    // 48h by RETENTION_RULES, so a lookback beyond it would return the 48h
    // number dressed up as a monthly one. The argument-less form uses its own
    // 24h window and is cached for 10 minutes; the `since` form is not cached.
    //
    // A NOTE ON WHAT THIS CHECK HAD TO BECOME. The obvious assertion —
    // "since 30 days ago returns at least as many as the default" — passes
    // whether the argument is honoured or dropped on the floor, because the
    // clamp collapses 30 days onto 48 hours and 48 hours is already >= 24.
    // It is the exact shape of a test that cannot fail. So: narrow the window
    // instead of widening it, and require the counts to move.
    const count = async (since: string | null): Promise<number> => {
      const d = await send<{ recentArticleCount: number }>(
        'MeraRecentArticleCount',
        { since },
      );
      assert(
        Number.isInteger(d.recentArticleCount),
        `recentArticleCount(since: ${since}) is not an integer`,
      );
      return d.recentArticleCount;
    };
    const ago = (hours: number) =>
      new Date(Date.now() - hours * 3_600_000).toISOString();

    const [oneHour, oneDay, twoDays, oneMonth, noArg] = await Promise.all([
      count(ago(1)),
      count(ago(24)),
      count(ago(48)),
      count(ago(24 * 30)),
      count(null),
    ]);

    // Narrowing the window can never return MORE rows.
    assert(
      oneHour <= oneDay && oneDay <= twoDays,
      `counts are not monotonic as the window narrows: ` +
        `1h=${oneHour} 24h=${oneDay} 48h=${twoDays}`,
    );
    // The clamp, pinned: beyond 48h must land exactly on the 48h answer.
    assert(
      oneMonth === twoDays,
      `since=30d (${oneMonth}) did not clamp to the 48h answer (${twoDays})`,
    );
    assert(Number.isInteger(noArg), 'the argument-less form is not an integer');

    // And say so out loud when the corpus is too uniform for the monotonic
    // assertion to have meant anything, rather than banking a silent pass.
    const discriminating = oneHour < oneDay || oneDay < twoDays;
    return discriminating
      ? `1h=${oneHour} 24h=${oneDay} 48h=${twoDays} 30d=${oneMonth} default=${noArg}`
      : `1h=${oneHour} 24h=${oneDay} 48h=${twoDays} 30d=${oneMonth} ` +
          `default=${noArg} — WARNING: every row falls in the last hour, so the ` +
          `window assertions could not discriminate on this corpus`;
  });

  await check('MeraArticleById', async () => {
    const d = await send<{ articleById: unknown }>('MeraArticleById', {
      id: seeds.articleId,
    });
    assertUsableArticle(d.articleById, 'articleById');
    const row = d.articleById as { _id: string; publicationSource?: unknown };
    assert(row._id === seeds.articleId, 'articleById returned a different id');
    assert(row.publicationSource, 'articleById has no publicationSource');
    return `${row._id} with publicationSource`;
  });

  await check('MeraArticlesForCountry', async () => {
    const d = await send<{
      articlesForCountry: {
        articles: unknown[];
        pageInfo: { hasNextPage: boolean };
      };
    }>('MeraArticlesForCountry', { countryCode: seeds.countryCode, first: 3 });
    assert(d.articlesForCountry.articles.length > 0, 'no articles returned');
    d.articlesForCountry.articles.forEach((a) =>
      assertUsableArticle(a, 'articlesForCountry'),
    );
    assert(
      typeof d.articlesForCountry.pageInfo.hasNextPage === 'boolean',
      'pageInfo.hasNextPage is not a boolean',
    );
    return `${d.articlesForCountry.articles.length} articles + pageInfo`;
  });

  await check('MeraArticlesForPublisher', async () => {
    const d = await send<{
      articlesForPublisher: { articles: unknown[] };
    }>('MeraArticlesForPublisher', {
      newsPublisherId: seeds.newsPublisherId,
      first: 3,
    });
    d.articlesForPublisher.articles.forEach((a) =>
      assertUsableArticle(a, 'articlesForPublisher'),
    );
    return `${d.articlesForPublisher.articles.length} articles`;
  });

  await check('MeraArticlesForSource', async () => {
    const d = await send<{
      articlesForPublicationSource: { articles: unknown[] };
    }>('MeraArticlesForSource', {
      publicationSourceId: seeds.publicationSourceId,
      first: 3,
    });
    d.articlesForPublicationSource.articles.forEach((a) =>
      assertUsableArticle(a, 'articlesForPublicationSource'),
    );
    return `${d.articlesForPublicationSource.articles.length} articles`;
  });

  await check('MeraNewsPublishers', async () => {
    const d = await send<{
      newsPublishers: {
        newsPublishers: { _id: string; name: string }[];
        pageInfo: { hasNextPage: boolean };
      };
    }>('MeraNewsPublishers', { countryCode: seeds.countryCode, first: 3 });
    const rows = d.newsPublishers.newsPublishers;
    assert(rows.length > 0, 'no publishers returned');
    rows.forEach((p) => {
      assert(p._id, 'publisher has no _id');
      assert(p.name, 'publisher has no name');
    });
    return `${rows.length} publishers`;
  });

  await check('MeraTopHeadlinesForCountry', async () => {
    const d = await send<{
      topHeadlinesForCountry: {
        headlines: { article: unknown }[];
        pageInfo: { hasNextPage: boolean };
      };
    }>('MeraTopHeadlinesForCountry', {
      countryCode: seeds.countryCode,
      first: 3,
    });
    d.topHeadlinesForCountry.headlines.forEach((h) =>
      assertUsableArticle(h.article, 'topHeadlinesForCountry'),
    );
    // An empty edition is a legitimate answer (the builder may not have run),
    // so this reports rather than fails. The document resolving at all is the
    // contract; what the edition holds is the pipeline's business.
    return `${d.topHeadlinesForCountry.headlines.length} headlines`;
  });

  await check('MeraRelatedArticles', async () => {
    const d = await send<{
      relatedArticles: unknown[];
      newsClusterForArticle: { _id: string } | null;
    }>('MeraRelatedArticles', {
      articleId: seeds.articleId,
      stableClusterId: null,
    });
    assert(Array.isArray(d.relatedArticles), 'relatedArticles is not an array');
    // Both root fields must be PRESENT in the payload — the adapter takes them
    // in one round trip and a missing key is not the same as a null value.
    assert(
      'newsClusterForArticle' in d,
      'newsClusterForArticle key is absent from the payload',
    );
    return `${d.relatedArticles.length} related, cluster=${
      d.newsClusterForArticle?._id ?? 'null'
    }`;
  });

  await check('MeraHydrateArticles', async () => {
    const d = await send<{
      articlesForTopicsByIds: {
        articles: unknown[];
        dailyLimitReached: boolean;
        resetAt: string | null;
      };
    }>('MeraHydrateArticles', { articleIds: [seeds.articleId] });
    const payload = d.articlesForTopicsByIds;
    assert(payload.articles.length === 1, 'expected exactly one hydrated row');
    assertUsableArticle(payload.articles[0], 'articlesForTopicsByIds');
    // NoopArticleQuota is what binds ARTICLE_QUOTA on this service. If this is
    // ever true here, the internal relay has acquired a meter it must not have
    // — and the symptom on the client's side would be a silently truncated feed.
    assert(
      payload.dailyLimitReached === false,
      'dailyLimitReached is TRUE on the unmetered internal API',
    );
    return 'hydrated 1, dailyLimitReached=false';
  });

  await check('MeraResolveTopics', async () => {
    const d = await send<{
      articleIdsForPersona: {
        topicResults: { topicText: string; articleIds: string[] }[];
        headlineResults: { scope: string; articleIds: string[] }[];
      };
    }>('MeraResolveTopics', {
      query: {
        // The headline half with NO topics is the cheapest valid request and
        // the one the app actually sends before it has any topics. It needs no
        // embedding provider, so it is the half that stays meaningful offline.
        topics: [],
        topHeadlines: {
          scopes: [{ scope: 'COUNTRY', countryCode: seeds.countryCode }],
        },
      },
    });
    const payload = d.articleIdsForPersona;
    assert(Array.isArray(payload.topicResults), 'topicResults is not an array');
    assert(
      Array.isArray(payload.headlineResults),
      'headlineResults is not an array',
    );
    assert(
      payload.topicResults.length === 0,
      'topics: [] returned topic results',
    );
    return `${payload.headlineResults.length} headline scope(s), 0 topic results`;
  });

  console.log(
    `\n${results.length} passed, ${failures.length} failed, ` +
      `${Object.keys(ADAPTER_DOCUMENTS).length} documents transcribed.`,
  );
  if (DUMP_PATH) {
    writeFileSync(DUMP_PATH, JSON.stringify(dumped, null, 2));
    console.log(`Wrote ${dumped.length} responses to ${DUMP_PATH}`);
  }
  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
