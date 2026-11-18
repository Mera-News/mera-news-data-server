import { Logger } from '@nestjs/common';
import { STORY_NAMES_PROMPT_VERSION } from '@mera/shared';
import { installAtlasSearchFake } from '../../../harness/atlas-search-fake';
import { bootNewsApi, type NewsApi } from '../support/boot-news-api';
import {
  seedArticle,
  seedSource,
  seedTopic,
  vectorWithScore,
} from '../support/fixtures';

const QUERY = `
query ResolveTopics($query: PersonaQueryInput!) {
  articleIdsForPersona(query: $query) {
    topicResults { articleIds }
  }
}`;

/** Every string the logger, stdout and stderr receive until `restore()`. */
function captureLogs() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => {
    lines.push(
      args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' '),
    );
  };
  Logger.overrideLogger({
    log: push,
    error: push,
    warn: push,
    debug: push,
    verbose: push,
    fatal: push,
  });
  const out = jest.spyOn(process.stdout, 'write').mockImplementation((c) => {
    push(String(c));
    return true;
  });
  const err = jest.spyOn(process.stderr, 'write').mockImplementation((c) => {
    push(String(c));
    return true;
  });
  return {
    lines,
    restore() {
      out.mockRestore();
      err.mockRestore();
      Logger.overrideLogger(false);
    },
  };
}

describe('topic text in the news API logs', () => {
  let api: NewsApi;
  let fake: ReturnType<typeof installAtlasSearchFake>;

  beforeAll(async () => {
    fake = installAtlasSearchFake();
    api = await bootNewsApi({ env: { LOG_LEVEL: 'info' } });
  });
  afterAll(async () => {
    await api.close();
    fake.uninstall();
  });

  const resolve = (text: string, strictMatch: boolean) =>
    api.gql(QUERY, {
      query: { topics: [{ text, strictMatch }], limitPerTopic: 20 },
    });

  it('logs counts for a name filter and a failed search, never the topic or its names', async () => {
    const strictTopic = 'Zorblax festival Quillon';
    const coldTopic = 'Vandermeer harbour Plinth';
    await api.resetDb();
    const source = await seedSource(api.connection);
    await seedArticle(api.connection, {
      source,
      vector: vectorWithScore(strictTopic, 1.0),
      overrides: {
        title: 'Zorblax opens',
        title_en_internal_only: 'Zorblax opens',
      },
    });
    await seedArticle(api.connection, {
      source,
      vector: vectorWithScore(strictTopic, 0.95),
    });
    await seedTopic(api.connection, strictTopic, {
      must_match: ['Zorblax'],
      must_match_version: STORY_NAMES_PROMPT_VERSION,
    });

    const capture = captureLogs();
    try {
      const strict = await resolve(strictTopic, true);
      expect(strict.body.errors).toBeUndefined();
      // The search has no index to run on, so the stage is rejected.
      fake.uninstall();
      try {
        await resolve(coldTopic, false);
      } finally {
        fake = installAtlasSearchFake();
      }
    } finally {
      capture.restore();
    }

    // Positive controls: the capture sees the request logs and both changed lines.
    expect(capture.lines.some((l) => l.includes('cold-embed:'))).toBe(true);
    expect(
      capture.lines.some((l) => /must-match \(.*\): kept=1 removed=1/.test(l)),
    ).toBe(true);
    expect(capture.lines.some((l) => l.includes('cold topic failed:'))).toBe(
      true,
    );
    for (const secret of [
      strictTopic,
      coldTopic,
      'Zorblax',
      'Quillon',
      'Vandermeer',
      'Plinth',
    ]) {
      expect(capture.lines.filter((l) => l.includes(secret))).toEqual([]);
    }
  });
});
