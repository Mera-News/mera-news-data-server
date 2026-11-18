import { getModelToken } from '@nestjs/mongoose';
import { http, HttpResponse } from 'msw';
import type { Model } from 'mongoose';
import { QueueName, buildArticleData } from '@mera/shared';
import { FakeEmbeddingProvider } from '../../../../libs/mera-shared/src/embedding-provider/fake-embedding.provider';
import { topicEmbedText } from '../../../../libs/mera-news-core/src/embedding-provider/topic-embed-text';
import { ArticleSearchService } from '../../../../apps/mera-server-async/src/modules/shared-utilities/article-search/article-search.service';
import { NewsPublisher } from '@mera/models/models/news-publisher.model';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import { bootAsyncApp, waitFor, type Harness } from '../../../harness/boot';
import { installAtlasSearchFake } from '../../../harness/atlas-search-fake';
import { server } from '../../../harness/msw';
import { vectorWithScore } from '../../retrieval/support/fixtures';

const TITLE = 'Harbour council approves new ferry timetable';
const DESCRIPTION =
  'The council voted on Tuesday to add two evening crossings to the island ferry, after a year of complaints from commuters who work late shifts on the mainland.';
const MATCHING_TEXT = buildArticleData(TITLE, DESCRIPTION, null, null);

const OPENAI_ENV = {
  EMBEDDING_PROVIDER: 'openai-compatible',
  EMBEDDING_BASE_URL: 'https://embeddings.example.test/v1',
  EMBEDDING_MODEL: 'fixture',
};

/** Boots the async app under `env`, runs `fn`, and puts the environment back. */
async function withBoot<T>(
  env: Record<string, string>,
  fn: (h: Harness) => Promise<T>,
): Promise<T> {
  const saved = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, env);
  try {
    const h = await bootAsyncApp();
    try {
      await h.resetDb();
      return await fn(h);
    } finally {
      // The next boot rebuilds its story index from whatever is left here.
      await h.resetDb();
      await h.close();
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const feedXml = (host: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${host}</title><link>https://${host}/</link><description>Fixture feed</description>
<language>en</language>
<item>
  <title>${TITLE}</title>
  <link>https://${host}/story</link>
  <description>${DESCRIPTION}</description>
  <pubDate>${new Date(Date.now() - 60_000).toUTCString()}</pubDate>
</item>
</channel></rss>`;

interface Outcome {
  articles: Record<string, unknown>[];
  canonicalLinks: number;
}

/**
 * Two publishers carry the same English story, one canonical topic sits at
 * `canonicalVector`, and the whole pipeline runs. Resolves once both articles
 * hold a story key.
 */
async function runFixture(
  h: Harness,
  canonicalVector: number[],
  expectLinks: boolean,
): Promise<Outcome> {
  const model = <T>(name: string) =>
    h.app.get<Model<T>>(getModelToken(name), { strict: false });
  for (const host of ['first.example.test', 'second.example.test']) {
    const publisher = await model<NewsPublisher>(NewsPublisher.name).create({
      name: host,
      country_code: 'GBR',
      is_active: true,
    });
    await model<PublicationSource>(PublicationSource.name).create({
      publication_name: host,
      feed_url: `https://${host}/rss.xml`,
      type: 'rss-feed',
      country_code: 'GBR',
      category: 'general',
      newsPublisherId: publisher._id,
    });
    server.use(
      http.get(`https://${host}/rss.xml`, () =>
        HttpResponse.text(feedXml(host), {
          headers: { 'content-type': 'application/rss+xml' },
        }),
      ),
    );
  }
  await h.connection.collection('user-topic').insertOne({
    news_topic_text: 'cat:fixture',
    news_topic_embed: canonicalVector,
    is_canonical: true,
    canonical_level: 1,
    canonical_embed: canonicalVector,
  });

  await h.runJob(QueueName.NEWS_SYNC_FANOUT, {});
  for (const stage of [
    QueueName.LOAD_RSS_FEED,
    QueueName.TRANSLATE_ARTICLE,
    QueueName.GENERATE_EMBEDDING_ARTICLE,
    QueueName.DATABASE_PROJECTOR,
  ]) {
    await h.drain(stage);
  }

  const articles = h.connection.collection('news-article');
  const links = h.connection.collection('topic-article-link');
  // The story key and the canonical links are written after the projector returns.
  await waitFor(async () =>
    (await articles.countDocuments({
      story_key: { $exists: true, $ne: '' },
    })) === 2
      ? true
      : null,
  );
  if (expectLinks)
    await waitFor(async () => (await links.countDocuments()) > 0);
  return {
    articles: await articles.find().toArray(),
    canonicalLinks: await links.countDocuments({ canonical: true }),
  };
}

describe('Jina-tuned rules follow the embedding model', () => {
  let calibrated: Outcome;
  let other: Outcome;
  let defaultFloorKept: unknown[];

  const topic = 'Floor topic';
  const searchBelowFloor = async (h: Harness) => {
    await h.connection.collection('news-article').insertOne({
      article_url: 'https://floor.example.test/story',
      createdAt: new Date(Date.now() - 60 * 60 * 1000),
      embedding_article_data_retrieval: vectorWithScore(topic, 0.85),
    });
    const fake = installAtlasSearchFake();
    try {
      return await h.app
        .get(ArticleSearchService, { strict: false })
        .searchArticlesForTopic(
          FakeEmbeddingProvider.vectorFor(topicEmbedText(topic)),
        );
    } finally {
      fake.uninstall();
    }
  };

  beforeAll(async () => {
    calibrated = await withBoot({ EMBEDDING_PROVIDER: 'fake' }, async (h) => {
      defaultFloorKept = await searchBelowFloor(h);
      await h.resetDb();
      return runFixture(
        h,
        FakeEmbeddingProvider.vectorFor(`text-matching:${MATCHING_TEXT}`),
        true,
      );
    });
    other = await withBoot(OPENAI_ENV, (h) => {
      server.use(
        http.post(
          `${OPENAI_ENV.EMBEDDING_BASE_URL}/embeddings`,
          async ({ request }) => {
            const { input } = (await request.json()) as { input: string[] };
            return HttpResponse.json({
              data: input.map((text, index) => ({
                index,
                embedding: FakeEmbeddingProvider.vectorFor(text),
              })),
            });
          },
        ),
      );
      return runFixture(
        h,
        FakeEmbeddingProvider.vectorFor(MATCHING_TEXT),
        false,
      );
    });
  });

  it('stores the sidecar for the calibrated model only', () => {
    expect(calibrated.articles).toHaveLength(2);
    for (const a of calibrated.articles)
      expect(a.vector_sidecar_packed).toBeTruthy();
    expect(other.articles).toHaveLength(2);
    for (const a of other.articles)
      expect(a.vector_sidecar_packed).toBeUndefined();
  });

  it('joins near copies from two publishers only for the calibrated model', () => {
    const keys = (o: Outcome) => new Set(o.articles.map((a) => a.story_key));
    expect(keys(calibrated).size).toBe(1);
    expect(keys(other).size).toBe(2);
  });

  it('links a matching canonical topic only for the calibrated model', () => {
    expect(calibrated.canonicalLinks).toBeGreaterThan(0);
    expect(other.canonicalLinks).toBe(0);
  });

  it('applies VECTOR_MIN_SCORE to topic linking', async () => {
    expect(defaultFloorKept).toHaveLength(1);
    const raised = await withBoot(
      { EMBEDDING_PROVIDER: 'fake', VECTOR_MIN_SCORE: '0.9' },
      searchBelowFloor,
    );
    expect(raised).toHaveLength(0);
  });
});
