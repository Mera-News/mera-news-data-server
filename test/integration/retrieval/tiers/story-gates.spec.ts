import { STORY_NAMES_GENERATOR } from '@mera/shared/story-names/story-names.port';
import type {
  StoryGatesOutcome,
  StoryNamesGenerator,
} from '@mera/shared/story-names/story-names.port';
import { FakeEmbeddingProvider } from '../../../../libs/mera-news-core/src/embedding-provider/fake-embedding.provider';
import { topicEmbedText } from '../../../../libs/mera-news-core/src/embedding-provider/topic-embed-text';
import {
  STORY_GATES_VERSION,
  STORY_GATE_KINDS,
} from '../../../../libs/mera-news-core/src/articles-for-topics/story-gates';
import { installAtlasSearchFake } from '../../../harness/atlas-search-fake';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import {
  seedArticle,
  seedSource,
  seedTopic,
  seedTopicLink,
} from '../support/fixtures';

const QUERY = `
query MeraResolveTopics($query: PersonaQueryInput!) {
  articleIdsForPersona(query: $query) {
    topicResults { topicText articleIds }
  }
}`;

interface Result {
  articleIdsForPersona: {
    topicResults: { topicText: string; articleIds: string[] }[];
  };
}

const PLACE = STORY_GATE_KINDS.place.threshold;

const unit = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};

/** A unit vector at exactly `cos` to `u` (both unit length). */
function atCos(u: number[], cos: number, seed: string): number[] {
  const raw = FakeEmbeddingProvider.vectorFor(seed);
  const dot = raw.reduce((s, x, i) => s + x * u[i], 0);
  const w = unit(raw.map((x, i) => x - dot * u[i]));
  const sin = Math.sqrt(1 - cos * cos);
  return u.map((x, i) => cos * x + sin * w[i]);
}

const gateVector = (text: string) => FakeEmbeddingProvider.vectorFor(text);

class FakeGates implements StoryNamesGenerator {
  calls: string[] = [];
  answer: StoryGatesOutcome = { status: 'ok', gates: [] };
  generate() {
    return Promise.resolve({ status: 'ok' as const, names: [] });
  }
  generatePlaceTerms() {
    return Promise.resolve({ status: 'ok' as const, names: [] });
  }
  generateStoryGates(topicText: string) {
    this.calls.push(topicText);
    return Promise.resolve(this.answer);
  }
}

describe('followed-story gates', () => {
  let api: NewsApi;
  let fake: ReturnType<typeof installAtlasSearchFake>;
  const gen = new FakeGates();

  beforeAll(async () => {
    fake = installAtlasSearchFake();
    api = await bootNewsApi({
      override: (b) => b.overrideProvider(STORY_NAMES_GENERATOR).useValue(gen),
    });
  });
  afterAll(async () => {
    await api.close();
    fake.uninstall();
  });
  // The classify cache outlives resetDb, so each test uses its own topic text.
  beforeEach(async () => {
    await api.resetDb();
    gen.calls = [];
    gen.answer = { status: 'ok', gates: [] };
  });

  const resolve = async (text: string, strictMatch = true) => {
    const res = await api.gql<Result>(QUERY, {
      query: { topics: [{ text, strictMatch }], limitPerTopic: 20 },
    });
    expect(res.body.errors).toBeUndefined();
    return res.body.data!.articleIdsForPersona.topicResults[0].articleIds;
  };

  /** A warm topic linked to one article per given retrieval vector. */
  async function warmTopic(text: string, vectors: (number[] | undefined)[]) {
    const source = await seedSource(api.connection);
    const topicId = await seedTopic(api.connection, text);
    const ids = [];
    for (const vector of vectors) {
      const id = await seedArticle(api.connection, { source, vector });
      await seedTopicLink(api.connection, topicId, id, 0.9);
      ids.push(id.toString());
    }
    return ids;
  }

  it('keeps only articles that pass the generated place gate, and stores the gate', async () => {
    const text = 'Femicide in the Netherlands';
    gen.answer = {
      status: 'ok',
      gates: [{ kind: 'place', text: 'Netherlands' }],
    };
    const g = gateVector('Netherlands');
    const [inside, outside, noVector] = await warmTopic(text, [
      atCos(g, PLACE + 0.05, 'a'),
      atCos(g, PLACE - 0.05, 'b'),
      undefined,
    ]);

    expect(await resolve(text)).toEqual([inside]);
    expect([outside, noVector]).not.toContain(inside);
    expect(gen.calls).toEqual([text]);

    const row = await api.connection
      .collection('user-topic')
      .findOne({ news_topic_text: text });
    expect(row?.story_gates_version).toBe(STORY_GATES_VERSION);
    expect(row?.story_gates).toEqual([
      { kind: 'place', text: 'Netherlands', vector: g },
    ]);
  });

  it('a story with no gates is the topic match alone', async () => {
    const text = 'Web Summit announcements';
    const ids = await warmTopic(text, [
      undefined,
      atCos(gateVector('x'), 0, 'c'),
    ]);

    expect((await resolve(text)).sort()).toEqual(ids.sort());
  });

  it('an article must pass every stored gate', async () => {
    const text = 'Amsterdam canal housing in the Netherlands';
    const a = gateVector('Amsterdam');
    const n = gateVector('Netherlands');
    // Halfway between the two gate vectors passes both; one alone passes one.
    const both = unit(a.map((x, i) => x + n[i]));
    const ids = await warmTopic(text, [both, a, n]);
    await api.connection.collection('user-topic').updateOne(
      { news_topic_text: text },
      {
        $set: {
          story_gates: [
            { kind: 'place', text: 'Amsterdam', vector: a },
            { kind: 'place', text: 'Netherlands', vector: n },
          ],
          story_gates_version: STORY_GATES_VERSION,
        },
      },
    );

    expect(await resolve(text)).toEqual([ids[0]]);
    expect(gen.calls).toEqual([]);
  });

  it('drops a gate of an unregistered kind or not grounded in the topic text', async () => {
    const text = 'Bhopal flooding';
    gen.answer = {
      status: 'ok',
      gates: [
        { kind: 'mood', text: 'Bhopal' },
        { kind: 'place', text: 'Madhya Pradesh' },
      ],
    };
    const ids = await warmTopic(text, [undefined, undefined]);

    expect((await resolve(text)).sort()).toEqual(ids.sort());
  });

  it('a failed generation answers nothing this request and is not cached', async () => {
    const text = 'Port strike in Rotterdam';
    gen.answer = { status: 'failed', reason: 'timeout' };
    const g = gateVector('Rotterdam');
    const [inside] = await warmTopic(text, [atCos(g, 0.9, 'd')]);

    expect(await resolve(text)).toEqual([]);

    gen.answer = {
      status: 'ok',
      gates: [{ kind: 'place', text: 'Rotterdam' }],
    };
    expect(await resolve(text)).toEqual([inside]);
  });

  it('applies on the cold path too', async () => {
    const text = 'Election recount in Utrecht';
    gen.answer = { status: 'ok', gates: [{ kind: 'place', text: 'Utrecht' }] };
    const t = FakeEmbeddingProvider.vectorFor(topicEmbedText(text));
    const g = gateVector('Utrecht');
    const source = await seedSource(api.connection);
    // Both near the topic; only the first also near the gate.
    const inside = await seedArticle(api.connection, {
      source,
      vector: unit(t.map((x, i) => x + g[i])),
    });
    await seedArticle(api.connection, { source, vector: t });

    expect(await resolve(text)).toEqual([inside.toString()]);
  });

  it('a loose topic is never gated', async () => {
    const text = 'Cycling in the Netherlands';
    gen.answer = {
      status: 'ok',
      gates: [{ kind: 'place', text: 'Netherlands' }],
    };
    const ids = await warmTopic(text, [undefined]);

    expect(await resolve(text, false)).toEqual(ids);
    expect(gen.calls).toEqual([]);
  });
});
