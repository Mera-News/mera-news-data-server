import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { UserTopic } from '@mera/models/models/user-topic.model';
import { installAtlasSearchFake } from '../../../harness/atlas-search-fake';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import {
  hoursAgo,
  seedArticle,
  seedHeadlineEdition,
  seedSource,
  seedTopic,
  seedTopicLink,
  vectorWithScore,
} from '../support/fixtures';

const QUERY = `
query MeraResolveTopics($query: PersonaQueryInput!) {
  articleIdsForPersona(query: $query) {
    topicResults { topicText articleIds matchMeta { articleId vectorScore } }
    headlineResults { scope articleIds }
  }
}`;

interface Result {
  articleIdsForPersona: {
    topicResults: {
      topicText: string;
      articleIds: string[];
      matchMeta: { articleId: string; vectorScore: number | null }[];
    }[];
    headlineResults: { scope: string; articleIds: string[] }[];
  };
}

describe('retrieval tiers', () => {
  let api: NewsApi;
  let fake: ReturnType<typeof installAtlasSearchFake>;

  beforeAll(async () => {
    fake = installAtlasSearchFake();
    api = await bootNewsApi();
  });
  afterAll(async () => {
    await api.close();
    fake.uninstall();
  });
  // The classify cache outlives resetDb, so each test uses its own topic text.
  beforeEach(async () => {
    await api.resetDb();
    fake.calls.length = 0;
  });

  const resolve = (topics: string[], extra: Record<string, unknown> = {}) =>
    api.gql<Result>(QUERY, {
      query: {
        topics: topics.map((text) => ({ text })),
        limitPerTopic: 20,
        ...extra,
      },
    });

  async function seedColdCorpus(topic: string) {
    const source = await seedSource(api.connection);
    const top = await seedArticle(api.connection, {
      source,
      vector: vectorWithScore(topic, 1.0),
    });
    const second = await seedArticle(api.connection, {
      source,
      vector: vectorWithScore(topic, 0.9),
    });
    await seedArticle(api.connection, {
      source,
      vector: vectorWithScore(topic, 0.77),
    });
    await seedArticle(api.connection, {
      source,
      createdAt: hoursAgo(25),
      vector: vectorWithScore(topic, 1.0),
    });
    await seedArticle(api.connection, {
      source,
      insecure: true,
      vector: vectorWithScore(topic, 1.0),
    });
    return [top.toString(), second.toString()];
  }

  it('cold path returns scored fresh secure articles and stores one anonymous topic row', async () => {
    const topic = 'Cold path topic';
    const expected = await seedColdCorpus(topic);

    const res = await resolve([topic]);

    expect(res.body.errors).toBeUndefined();
    const [result] = res.body.data!.articleIdsForPersona.topicResults;
    expect(result.articleIds).toEqual(expected);
    expect(result.matchMeta[0].vectorScore).toBeCloseTo(1.0, 3);
    expect(result.matchMeta[1].vectorScore).toBeCloseTo(0.9, 3);

    const rows = await api.connection.collection('user-topic').find().toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].news_topic_text).toBe(topic);
    const model = api.app.get<Model<unknown>>(getModelToken(UserTopic.name));
    const declared = new Set([
      ...Object.keys(model.schema.paths),
      '_id',
      '__v',
    ]);
    expect(Object.keys(rows[0]).filter((k) => !declared.has(k))).toEqual([]);
  });

  it('classify cache answers a repeated request without a second search', async () => {
    const topic = 'Cached topic';
    await seedColdCorpus(topic);

    const first = await resolve([topic]);
    const second = await resolve([topic]);

    expect(
      second.body.data!.articleIdsForPersona.topicResults[0].articleIds,
    ).toEqual(first.body.data!.articleIdsForPersona.topicResults[0].articleIds);
    expect(
      first.body.data!.articleIdsForPersona.topicResults[0].articleIds,
    ).toHaveLength(2);
    expect(fake.calls).toHaveLength(1);
  });

  it('warm path orders links by confidence then id, with no search and no score', async () => {
    const topic = 'Warm topic';
    const source = await seedSource(api.connection);
    const a = await seedArticle(api.connection, { source });
    const b = await seedArticle(api.connection, { source });
    const c = await seedArticle(api.connection, { source });
    const old = await seedArticle(api.connection, {
      source,
      createdAt: hoursAgo(25),
    });
    const topicId = await seedTopic(api.connection, topic);
    // Inserted out of order so the tie-break, not insertion order, decides.
    await seedTopicLink(api.connection, topicId, c, 0.8);
    await seedTopicLink(api.connection, topicId, b, 0.9);
    await seedTopicLink(api.connection, topicId, a, 0.9);
    await seedTopicLink(api.connection, topicId, old, 1.0);

    const res = await resolve([topic]);

    expect(res.body.errors).toBeUndefined();
    const [result] = res.body.data!.articleIdsForPersona.topicResults;
    expect(result.articleIds).toEqual([a, b, c].map(String));
    expect(result.articleIds).not.toContain(old.toString());
    expect(result.matchMeta.map((m) => m.vectorScore)).toEqual([
      null,
      null,
      null,
    ]);
    expect(fake.calls).toHaveLength(0);
  });

  it('never returns links stored on a canonical row', async () => {
    const source = await seedSource(api.connection);
    const linked = await seedArticle(api.connection, { source });
    const topicId = await seedTopic(api.connection, 'cat:sport', {
      is_canonical: true,
    });
    await seedTopicLink(api.connection, topicId, linked, 0.9);

    const res = await resolve(['cat:sport']);

    expect(res.body.errors).toBeUndefined();
    const ids = res.body.data!.articleIdsForPersona.topicResults.flatMap(
      (r) => r.articleIds,
    );
    expect(ids).not.toContain(linked.toString());
  });

  it('serves headlines alone when no topics are sent', async () => {
    const source = await seedSource(api.connection);
    const ids = [
      await seedArticle(api.connection, { source }),
      await seedArticle(api.connection, { source }),
    ];
    await seedHeadlineEdition(api.connection, 'GLOBAL', ids);

    const res = await resolve([], {
      topHeadlines: { scopes: [{ scope: 'GLOBAL' }], limitPerScope: 10 },
    });

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data!.articleIdsForPersona.headlineResults).toEqual([
      { scope: 'GLOBAL', articleIds: ids.map(String) },
    ]);
    expect(fake.calls).toHaveLength(0);
  });
});
