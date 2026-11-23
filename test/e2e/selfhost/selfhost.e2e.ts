import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient, type Db } from 'mongodb';
import {
  NEWS_ARTICLE_COLLECTION,
  VECTOR_INDEX_NAME,
  retrievalIndexDefinition,
} from '../../../libs/mera-models/src/search-index/retrieval-index';

/**
 * What a reader of the self-hosting guide ends up with, checked after
 * run-docs.mjs has followed the guide against a real search index, real Redis,
 * a fake embeddings server and a fixture publisher. The checks that break the
 * install come last.
 */

const repo = resolve(__dirname, '../../..');
const worker = 'http://127.0.0.1:8080';
const newsApi = 'http://127.0.0.1:3002';
const publisher = 'http://127.0.0.1:8765';
const refusedSource = 'http://169.254.169.254/latest/meta-data/';

interface Item {
  feed: string;
  story: string | null;
  slug: string;
  title: string;
}
const fixtures = JSON.parse(
  readFileSync(resolve(__dirname, 'fixtures/stories.json'), 'utf8'),
) as {
  feeds: { slug: string; language: string }[];
  items: Item[];
};
const linkOf = (item: Item) => `https://${item.feed}.example.test/${item.slug}`;
const languageOf = (item: Item) =>
  fixtures.feeds.find((f) => f.slug === item.feed)!.language;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until<T>(
  what: string,
  check: () => Promise<T | undefined>,
  timeoutMs = 300_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await sleep(3000);
  }
  throw new Error(`timed out waiting for ${what}: ${String(last)}`);
}

interface GraphqlAnswer<T> {
  data?: T;
  errors?: {
    message: string;
    extensions?: { code?: string; state?: string };
  }[];
}
async function graphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<GraphqlAnswer<T>> {
  const res = await fetch(`${newsApi}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GraphqlAnswer<T>;
}

const topicQuery = `query ($text: String!) {
  articleIdsForPersona(query: { topics: [{ text: $text }], limitPerTopic: 5 }) {
    topicResults { topicText articleIds matchMeta { articleId vectorScore } }
  }
}`;

interface TopicAnswer {
  articleIdsForPersona: {
    topicResults: {
      articleIds: string[];
      matchMeta: { vectorScore: number | null }[];
    }[];
  };
}
interface Health {
  status: number;
  vectorState: string;
}
async function health(base: string): Promise<Health> {
  const res = await fetch(`${base}/health/ready`);
  const body = (await res.json()) as {
    details: { vectorIndex: { state: string } };
  };
  return { status: res.status, vectorState: body.details.vectorIndex.state };
}

describe('the self-hosting guide, followed', () => {
  let mongo: MongoClient;
  let db: Db;
  const ids = new Map<string, string>();
  const idsOf = (story: string) =>
    fixtures.items
      .filter((i) => i.story === story)
      .map((i) => ids.get(linkOf(i))!);

  beforeAll(async () => {
    mongo = await MongoClient.connect(process.env.MONGODB_URI as string);
    db = mongo.db();
  });

  afterAll(async () => {
    await mongo.close();
  });

  it('shows the vector index ready, with stored vectors 768 long', async () => {
    await until('the vector index to be ready', async () => {
      const { status, vectorState } = await health(worker);
      return status === 200 && vectorState === 'ready' ? true : undefined;
    });
    const news = await health(newsApi);
    expect(news.vectorState).toBe('ready');
    const embedded = await until(
      'every fixture item to be embedded',
      async () => {
        const count = await db
          .collection(NEWS_ARTICLE_COLLECTION)
          .countDocuments({
            'embedding_article_data_retrieval.0': { $exists: true },
          });
        return count >= fixtures.items.length ? count : undefined;
      },
    );
    expect(embedded).toBe(fixtures.items.length);
    const one = await db
      .collection(NEWS_ARTICLE_COLLECTION)
      .findOne({ 'embedding_article_data_retrieval.0': { $exists: true } });
    expect(one!.embedding_article_data_retrieval).toHaveLength(768);
  });

  it('stores every fixture item once, and keeps the French and Spanish ones untranslated', async () => {
    for (const item of fixtures.items) {
      const rows = await db
        .collection(NEWS_ARTICLE_COLLECTION)
        .find({ article_url: linkOf(item) })
        .toArray();
      expect(rows).toHaveLength(1);
      ids.set(linkOf(item), String(rows[0]._id));
      if (languageOf(item) !== 'en') {
        expect(rows[0].title).toBe(item.title);
        // Stored as title_en_internal_only; GraphQL's title_en reads it.
        expect(rows[0].title_en_internal_only).toBe(item.title);
        expect(rows[0].original_language_code).toBe(languageOf(item));
      }
    }
    expect(
      await db.collection(NEWS_ARTICLE_COLLECTION).countDocuments({}),
    ).toBe(fixtures.items.length);
  });

  it('reads the sixth source as refused, and the publisher never saw a request for it', async () => {
    const sources = db.collection('publication-source');
    const refused = await until(
      'the refused source to be recorded',
      async () =>
        (await sources.findOne({
          feed_url: refusedSource,
          last_fetch_status: 'refused',
        })) ?? undefined,
    );
    expect(refused.last_fetch_status).toBe('refused');
    expect(
      await sources.countDocuments({
        feed_url: { $regex: '^http://127.0.0.1:8765/' },
        last_fetch_status: 'ok',
      }),
    ).toBe(fixtures.feeds.length);
    const hits = (await (
      await fetch(`${publisher}/__hits`)
    ).json()) as string[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.filter((path) => !path.startsWith('/feeds/'))).toEqual([]);
  });

  it('answers the guide topic query with that story only, without a score, and a gibberish topic with nothing', async () => {
    const answer = await graphql<TopicAnswer>(topicQuery, {
      text: 'electric buses',
    });
    expect(answer.errors).toBeUndefined();
    const [result] = answer.data!.articleIdsForPersona.topicResults;
    expect([...result.articleIds].sort()).toEqual(idsOf('buses').sort());
    expect(result.matchMeta.map((m) => m.vectorScore)).toEqual([
      null,
      null,
      null,
    ]);
    const none = await graphql<TopicAnswer>(topicQuery, { text: 'qwxz plorb' });
    expect(none.data!.articleIdsForPersona.topicResults[0].articleIds).toEqual(
      [],
    );
  });

  it('groups no stories: every fixture item has no cluster and no related articles', async () => {
    for (const item of fixtures.items) {
      const id = ids.get(linkOf(item));
      const answer = await graphql<{
        newsClusterForArticle: unknown;
        relatedArticles: unknown[];
      }>(
        `query ($id: ID!) {
          newsClusterForArticle(articleId: $id) { _id }
          relatedArticles(articleId: $id) { _id }
        }`,
        { id },
      );
      expect(answer.errors).toBeUndefined();
      expect(answer.data!.newsClusterForArticle).toBeNull();
      expect(answer.data!.relatedArticles).toEqual([]);
    }
  });

  it('answers topHeadlinesForCountry with headlines that stand alone', async () => {
    const answer = await graphql<{
      topHeadlinesForCountry: { headlines: { clusterSize: number }[] };
    }>(`
      {
        topHeadlinesForCountry(countryCode: "GBR", first: 5) {
          headlines {
            clusterSize
            article {
              article_url
            }
          }
        }
      }
    `);
    expect(answer.errors).toBeUndefined();
    const { headlines } = answer.data!.topHeadlinesForCountry;
    expect(headlines.length).toBeGreaterThan(0);
    expect(headlines.map((h) => h.clusterSize)).toEqual(
      headlines.map(() => 0),
    );
  });

  // From here on the install is damaged on purpose.

  it('refuses to start a news API that disagrees with the vector size', async () => {
    const child = spawn('node', ['dist/apps/mera-server-news-api/main.js'], {
      cwd: repo,
      env: { ...process.env, EMBEDDING_DIMS: '1024', NEWS_API_PORT: '3199' },
    });
    let output = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    const code = await new Promise<number | null>((done) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(null);
      }, 120_000);
      child.once('exit', (c) => {
        clearTimeout(timer);
        done(c);
      });
    });
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(output).toContain('768');
    expect(output).toContain('1024');
  });

  it('says INDEX_NOT_READY for a cold topic once the vector index is gone, and keeps /health/ready at 200', async () => {
    const articles = db.collection(NEWS_ARTICLE_COLLECTION);
    await articles.dropSearchIndex(VECTOR_INDEX_NAME);
    await until('the vector index to be dropped', async () =>
      (await articles.listSearchIndexes().toArray()).some(
        (i) => i.name === VECTOR_INDEX_NAME,
      )
        ? undefined
        : true,
    );
    try {
      await sleep(31_000);
      const answer = await graphql<TopicAnswer>(topicQuery, {
        text: `tram lines in ${Date.now()}`,
      });
      expect(answer.errors?.[0].extensions?.code).toBe('INDEX_NOT_READY');
      expect(answer.errors?.[0].extensions?.state).toBe('missing');
      for (const base of [newsApi, worker]) {
        const { status, vectorState } = await health(base);
        expect(status).toBe(200);
        expect(vectorState).toBe('missing');
      }
    } finally {
      // The workflow runs a pod against this install next, so put the index back.
      const { name, type, definition } = retrievalIndexDefinition(768);
      await articles.createSearchIndex({ name, type, definition });
      await until('the vector index to be ready again', async () => {
        const { vectorState } = await health(newsApi);
        return vectorState === 'ready' ? true : undefined;
      });
    }
  }, 600_000);
});
