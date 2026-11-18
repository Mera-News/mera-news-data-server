import { installAtlasSearchFake } from '../../../harness/atlas-search-fake';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import { seedArticle, seedSource, vectorWithScore } from '../support/fixtures';

const QUERY = `
query ResolveTopics($query: PersonaQueryInput!) {
  articleIdsForPersona(query: $query) {
    topicResults { articleIds matchMeta { articleId vectorScore } }
  }
}`;

interface Result {
  articleIdsForPersona: {
    topicResults: {
      articleIds: string[];
      matchMeta: { articleId: string; vectorScore: number | null }[];
    }[];
  };
}

describe('score gate and floor', () => {
  let fake: ReturnType<typeof installAtlasSearchFake>;

  beforeAll(() => {
    fake = installAtlasSearchFake();
  });
  afterAll(() => fake.uninstall());

  /** Seeds one corpus, then asks for the topic under each env, one boot each. */
  async function resolveUnder(
    envs: Record<string, string>[],
    topic: string,
    scores: number[],
  ) {
    const first: NewsApi = await bootNewsApi();
    try {
      await first.resetDb();
      const source = await seedSource(first.connection);
      for (const score of scores) {
        await seedArticle(first.connection, {
          source,
          vector: vectorWithScore(topic, score),
        });
      }
    } finally {
      await first.close();
    }
    const results = [];
    for (const env of envs) results.push(await resolve(env, topic));
    return results;
  }

  async function resolve(env: Record<string, string>, topic: string) {
    const api: NewsApi = await bootNewsApi({ env });
    try {
      const res = await api.gql<Result>(QUERY, {
        query: { topics: [{ text: topic }], limitPerTopic: 20 },
      });
      expect(res.body.errors).toBeUndefined();
      return res.body.data!.articleIdsForPersona.topicResults[0];
    } finally {
      await api.close();
    }
  }

  it('sends the score on the tuned model', async () => {
    const [result] = await resolveUnder([{}], 'Calibrated score topic', [0.9]);

    expect(result.matchMeta).toHaveLength(1);
    expect(result.matchMeta[0].vectorScore).toBeCloseTo(0.9, 3);
  });

  it('sends no score off the tuned model and keeps the same articles', async () => {
    const [tuned, other] = await resolveUnder(
      [{}, { JINA_MODEL: 'other-model' }],
      'Uncalibrated score topic',
      [0.9, 0.85],
    );

    expect(other.articleIds).toHaveLength(2);
    expect(other.articleIds).toEqual(tuned.articleIds);
    expect(other.matchMeta.map((m) => m.vectorScore)).toEqual([null, null]);
  });

  it('drops an article under VECTOR_MIN_SCORE that the default floor keeps', async () => {
    const [kept, floored] = await resolveUnder(
      [{}, { VECTOR_MIN_SCORE: '0.9' }],
      'Floor topic',
      [0.95, 0.85],
    );

    expect(kept.articleIds).toHaveLength(2);
    expect(floored.articleIds).toHaveLength(1);
  });
});
