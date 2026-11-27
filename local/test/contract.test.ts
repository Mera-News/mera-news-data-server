// The one-computer setup must speak the full server's GraphQL. The schema is a
// byte copy, every client document validates against it, and every document
// either runs on the store or answers empty or NOT_IN_LOCAL_MODE, as its type says.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  GraphQLEnumType,
  GraphQLList,
  GraphQLNonNull,
  getNamedType,
  parse,
  print,
  validate,
  type GraphQLInputType,
  type OperationDefinitionNode,
  type TypeNode,
} from 'graphql';
import { CLIENT_DOCUMENTS } from '../../apps/mera-server-news-api/src/modules/client-documents.ts';
import { createFakeEmbedder } from '../src/embed/fake.ts';
import { LOCAL_RESOLVERS, buildLocalSchema, runQuery } from '../src/serve/graphql.ts';
import { Store } from '../src/store/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'mera-news-local-contract-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const schema = buildLocalSchema();
const embedder = createFakeEmbedder(8);
let store: Store;
let articleId = '';
let publisherId = '';

before(async () => {
  store = new Store(join(dir, 'news.db'));
  store.assertEmbeddingModel({ id: embedder.model, dims: embedder.dims });
  const feed = store.upsertFeed({
    feedUrl: 'https://harbour.example.test/rss',
    publicationName: 'Harbour Gazette',
    publicationUrl: 'https://harbour.example.test',
    countryCode: 'GBR',
    feedLanguageCode: 'en',
    publisher: { name: 'Harbour Gazette', countryCode: 'GBR', websiteUrl: 'https://harbour.example.test' },
  });
  const title = 'Harbour works begin on the new lighthouse pier';
  const run = store.startRun();
  const written = store.writeFeedFetch(
    feed.id,
    [
      {
        articleUrl: 'https://harbour.example.test/pier',
        fingerprint: 'url:https://harbour.example.test/pier',
        copyKeys: [],
        title,
        description: 'Work on the pier starts on Monday.',
        imageUrl: 'https://harbour.example.test/pier.jpg',
        languageCode: 'en',
        pubDate: new Date().toISOString(),
        vector: (await embedder.embedPassages([`${title}\nWork on the pier starts on Monday.`]))[0]!,
      },
    ],
    { at: new Date().toISOString(), status: 'ok' },
    run,
  );
  store.finishRun(run, { feedsOk: 1, feedsFailed: 0, articlesNew: 1 });
  articleId = written.inserted[0]!.id;
  publisherId = store.listFeeds()[0]!.publisher_id;
});
after(() => store.close());

function typeOf(node: TypeNode): GraphQLInputType {
  if (node.kind === 'NonNullType') return new GraphQLNonNull(typeOf(node.type) as never);
  if (node.kind === 'ListType') return new GraphQLList(typeOf(node.type));
  return schema.getType(node.name.value) as GraphQLInputType;
}

/** A plausible value for each variable, from its name and type. */
function valueFor(name: string, type: GraphQLInputType): unknown {
  const required = type instanceof GraphQLNonNull;
  const inner = required ? (type as GraphQLNonNull<GraphQLInputType>).ofType : type;
  if (inner instanceof GraphQLList) return [valueFor(name.replace(/s$/, ''), inner.ofType as GraphQLInputType)];
  const named = getNamedType(inner);
  if (named.name === 'PersonaQueryInput') return { topics: [{ text: 'harbour works' }], limitPerTopic: 5, topHeadlines: { scopes: [{ scope: 'GLOBAL' }] } };
  if (named instanceof GraphQLEnumType) return named.getValues()[0]!.value;
  // An optional variable is left out, so the argument's own default applies.
  if (!required && !['countryCode', 'query', 'name'].includes(name)) return undefined;
  if (named.name === 'ID') return /publisher/i.test(name) ? publisherId : articleId;
  if (named.name === 'Int') return 5;
  if (named.name === 'String') return name === 'countryCode' ? 'GBR' : 'Harbour';
  return null;
}

const documents = Object.entries(CLIENT_DOCUMENTS).map(([name, text]) => {
  const document = parse(text);
  const op = document.definitions.find((d) => d.kind === 'OperationDefinition') as OperationDefinitionNode;
  // Built when a test runs, after the store is seeded.
  const variables = () =>
    Object.fromEntries(
      (op.variableDefinitions ?? []).map((v) => [v.variable.name.value, valueFor(v.variable.name.value, typeOf(v.type))]).filter(([, value]) => value !== undefined),
    );
  const roots = op.selectionSet.selections.map((s) => (s.kind === 'Field' ? s.name.value : ''));
  return { name, text, document, variables, roots };
});

describe('the contract with the full server', () => {
  it('serves a byte copy of the full server schema', () => {
    const ours = readFileSync(new URL('../schema.gql', import.meta.url));
    const theirs = readFileSync(new URL('../../apps/mera-server-news-api/src/schema.gql', import.meta.url));
    assert.ok(ours.equals(theirs), 'local/schema.gql differs from the full server schema: copy it again');
  });

  it('accepts every client document', () => {
    for (const d of documents) assert.deepEqual(validate(schema, d.document).map((e) => e.message), [], d.name);
  });

  for (const d of documents) {
    it(`${d.name}: answers as local mode promises`, async () => {
      const { result } = await runQuery(schema, { store, embedder }, { query: d.text, variables: d.variables() });
      const query = schema.getQueryType()!.getFields();
      for (const root of d.roots) {
        const field = query[root]!;
        const value = (result.data as Record<string, unknown> | null | undefined)?.[root];
        const errors = (result.errors ?? []).filter((e) => e.path?.[0] === root);
        if (LOCAL_RESOLVERS.includes(root)) {
          assert.deepEqual(errors.map((e) => e.message), [], `${root} failed`);
          assert.notEqual(value, undefined);
          continue;
        }
        const inner = field.type instanceof GraphQLNonNull ? field.type.ofType : field.type;
        if (inner instanceof GraphQLList) assert.deepEqual(value, [], `${root} should answer []`);
        else if (!(field.type instanceof GraphQLNonNull)) assert.equal(value, null, `${root} should answer null`);
        else assert.deepEqual(errors.map((e) => e.extensions?.code), ['NOT_IN_LOCAL_MODE'], `${root} should answer NOT_IN_LOCAL_MODE`);
      }
    });
  }

  it('finds the stored article for the operations a pod sends', async () => {
    const run = async (name: string) => {
      const d = documents.find((x) => x.name === name)!;
      const { result } = await runQuery(schema, { store, embedder }, { query: d.text, variables: d.variables() });
      assert.equal(result.errors, undefined, `${name}: ${print(d.document).slice(0, 60)}`);
      return result.data as Record<string, any>;
    };
    const persona = await run('GetArticleIdsForPersona');
    assert.deepEqual(persona.articleIdsForPersona.topicResults[0].articleIds, [articleId]);
    assert.equal(persona.articleIdsForPersona.topicResults[0].matchMeta[0].vectorScore, null);
    const hydrated = await run('GetArticlesForTopicsByIds');
    const article = hydrated.articlesForTopicsByIds.articles[0];
    assert.equal(article.title_en, article.title);
    const limit = await runQuery(schema, { store, embedder }, { query: `{ articlesForTopicsByIds(articleIds: ["${articleId}"]) { dailyLimitReached articles { vector_sidecar_packed clusters { clusterId } } } }` });
    assert.deepEqual(JSON.parse(JSON.stringify(limit.result.data)), { articlesForTopicsByIds: { dailyLimitReached: false, articles: [{ vector_sidecar_packed: null, clusters: [] }] } });
    const country = await run('GetArticlesForCountry');
    assert.equal(country.articlesForCountry.articles[0]._id, articleId);
    const search = await run('SearchNews');
    assert.equal(search.searchNews[0]._id, articleId);
    const status = await run('NewsServerStatus');
    assert.ok(status.newsServerStatus.lastArticleAt);
    assert.deepEqual((await run('AllCountries')).allCountries, ['GBR']);
    assert.equal((await run('GetRecentArticleCount')).recentArticleCount, 1);
    assert.equal((await run('SearchPublishers')).searchPublishers.publishers[0].name, 'Harbour Gazette');
    assert.equal((await run('PublicationSourcesForNewsPublisher')).publicationSourcesForNewsPublisher.publicationSources.length, 1);
    assert.deepEqual((await run('GetTopHeadlinesForCountry')).topHeadlinesForCountry.headlines, []);
  });

  it("answers an article's feed language when the text gave none, as the full server does", async () => {
    const feed = store.upsertFeed({
      feedUrl: 'https://short.example.test/rss',
      publicationName: '',
      publicationUrl: null,
      countryCode: 'GBR',
      feedLanguageCode: 'en-gb',
      publisher: { name: 'short.example.test', countryCode: 'GBR', websiteUrl: null },
    });
    const short = store.writeFeedFetch(
      feed.id,
      [{ articleUrl: 'https://short.example.test/1', fingerprint: 'url:short/1', copyKeys: [], title: 'Rates hold', description: null, imageUrl: null, languageCode: null, pubDate: new Date().toISOString(), vector: (await embedder.embedPassages(['Rates hold']))[0]! }],
      { at: new Date().toISOString(), status: 'ok' },
      null,
    ).inserted[0]!.id;
    const { result } = await runQuery(schema, { store, embedder }, { query: `{ articlesForTopicsByIds(articleIds: ["${short}"]) { articles { language_code publication_name } } }` });
    assert.deepEqual(JSON.parse(JSON.stringify(result.data)), { articlesForTopicsByIds: { articles: [{ language_code: 'en-gb', publication_name: 'short.example.test' }] } });
  });

  it('refuses a field the schema does not have, as the full server does', async () => {
    const { status, result } = await runQuery(schema, { store, embedder }, { query: '{ publicationDisplayNames { name } }' });
    assert.equal(status, 400);
    assert.equal(result.errors?.[0]?.extensions?.code, 'GRAPHQL_VALIDATION_FAILED');
  });

  it('pages articlesForCountry with a cursor and refuses one it did not give out', async () => {
    const seen: string[] = [];
    let after: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const { result } = await runQuery(schema, { store, embedder }, {
        query: `{ articlesForCountry(countryCode: "GLOBAL", first: 1${after ? `, after: "${after}"` : ''}) { articles { _id } pageInfo { endCursor hasNextPage } } }`,
      });
      const page = (result.data as any).articlesForCountry;
      seen.push(...page.articles.map((a: { _id: string }) => a._id));
      if (!page.pageInfo.hasNextPage) break;
      after = page.pageInfo.endCursor;
    }
    assert.equal(seen.length, store.articleCount());
    assert.equal(new Set(seen).size, seen.length);
    const bad = await runQuery(schema, { store, embedder }, { query: '{ articlesForCountry(after: "nonsense") { articles { _id } } }' });
    assert.equal(bad.result.errors?.[0]?.extensions?.code, 'BAD_USER_INPUT');
  });

  it('answers articlesForCountry order NEWEST with one cursor per article that continues after it', async () => {
    const ask = async (after?: string) => {
      const { result } = await runQuery(schema, { store, embedder }, {
        query: `{ articlesForCountry(countryCode: "GLOBAL", first: 10, order: NEWEST${after ? `, after: "${after}"` : ''}) { articles { _id } itemCursors } }`,
      });
      assert.equal(result.errors, undefined);
      return (result.data as any).articlesForCountry as { articles: { _id: string }[]; itemCursors: string[] };
    };
    const all = await ask();
    assert.ok(all.articles.length >= 2);
    assert.equal(all.itemCursors.length, all.articles.length);
    const rest = await ask(all.itemCursors[0]);
    assert.deepEqual(rest.articles.map((a) => a._id), all.articles.slice(1).map((a) => a._id));
  });

  it('pages searchNewsPage to the end and refuses a cursor it did not give out', async () => {
    const ask = async (after?: string | null, limit = 1) =>
      runQuery(schema, { store, embedder }, {
        query: 'query($after: String, $limit: Int) { searchNewsPage(query: "Harbour", limit: $limit, after: $after) { hits { _id } nextCursor } }',
        variables: { after, limit },
      });
    const whole = ((await ask(null, 100)).result.data as any).searchNewsPage;
    assert.ok(whole.hits.length >= 2);
    assert.equal(whole.nextCursor, null);
    const seen: string[] = [];
    let after: string | null = null;
    for (let pages = 0; pages < 20; pages++) {
      const { result } = await ask(after);
      assert.equal(result.errors, undefined);
      const page = (result.data as any).searchNewsPage;
      seen.push(...page.hits.map((h: { _id: string }) => h._id));
      after = page.nextCursor;
      if (!after) break;
    }
    assert.deepEqual(seen, whole.hits.map((h: { _id: string }) => h._id));
    const deep = Buffer.from(JSON.stringify({ asOf: new Date().toISOString(), from: new Date(Date.now() - 48 * 3600_000).toISOString(), offset: 2400 })).toString('base64');
    const end = await ask(deep, 100);
    assert.equal(end.result.errors, undefined);
    assert.deepEqual({ ...(end.result.data as any).searchNewsPage }, { hits: [], nextCursor: null });
    const bad = await ask('nonsense');
    assert.equal(bad.result.errors?.[0]?.extensions?.code, 'BAD_USER_INPUT');
    // The full server's bounds: ahead of the clock, a window past 48h, a window that starts after it ends.
    const now = Date.now();
    const cursor = (asOf: number, from: number) => Buffer.from(JSON.stringify({ asOf: new Date(asOf).toISOString(), from: new Date(from).toISOString(), offset: 0 })).toString('base64');
    for (const forged of [cursor(now + 3600_000, now - 47 * 3600_000), cursor(now, now - 400 * 3600_000), cursor(now - 3600_000, now)]) {
      const refused = await ask(forged);
      assert.equal(refused.result.errors?.[0]?.extensions?.code, 'BAD_USER_INPUT');
    }
    assert.equal((await ask(cursor(now + 2 * 60_000, now - 47 * 3600_000))).result.errors, undefined);
  });

  it('caps an articlesForCountry NEWEST page at 50, as the full server does', async () => {
    const feed = store.upsertFeed({
      feedUrl: 'https://many.example.test/rss',
      publicationName: 'Many',
      publicationUrl: null,
      countryCode: 'GBR',
      feedLanguageCode: 'en',
      publisher: { name: 'Many', countryCode: 'GBR', websiteUrl: null },
    });
    const vector = (await embedder.embedPassages(['Many items']))[0]!;
    const items = Array.from({ length: 60 }, (_, i) => ({ articleUrl: `https://many.example.test/${i}`, fingerprint: `url:many/${i}`, copyKeys: [], title: `Many item ${i}`, description: null, imageUrl: null, languageCode: null, pubDate: new Date().toISOString(), vector }));
    store.writeFeedFetch(feed.id, items, { at: new Date().toISOString(), status: 'ok' }, null);
    const { result } = await runQuery(schema, { store, embedder }, {
      query: '{ articlesForCountry(countryCode: "GLOBAL", first: 100, order: NEWEST) { articles { _id } itemCursors } }',
    });
    assert.equal((result.data as any).articlesForCountry.articles.length, 50);
  });
});
