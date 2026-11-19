import { Logger } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { http, HttpResponse } from 'msw';
import { Types, type Model } from 'mongoose';
import { QueueName } from '@mera/shared';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import { bootAsyncApp, type Harness } from '../../../harness/boot';
import { server } from '../../../harness/msw';

const rss = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>Fixture</title><link>https://dupes.example.test/</link><description>Fixture feed</description>
<language>en</language>${items}</channel></rss>`;

const item = (title: string, link: string) => `
<item>
  <title>${title}</title>
  <link>${link}</link>
  <description>A fixture story that is long enough to count as a real description for the feed fixture, written in plain English.</description>
  <pubDate>${new Date(Date.now() - 60_000).toUTCString()}</pubDate>
</item>`;

type LoadResult = {
  result: {
    newArticles: number;
    duplicates: number;
    errors: number;
  };
};

describe('feed load: duplicate and failed articles', () => {
  let h: Harness;
  let sources: Model<PublicationSource>;
  let lines: string[];

  beforeAll(async () => {
    h = await bootAsyncApp();
    sources = h.app.get<Model<PublicationSource>>(
      getModelToken(PublicationSource.name),
      { strict: false },
    );
  });
  afterAll(() => h?.close());
  beforeEach(async () => {
    await h.resetDb();
    lines = [];
    const push = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    Logger.overrideLogger({
      log: push,
      error: push,
      warn: push,
      debug: push,
      verbose: push,
      fatal: push,
    });
  });
  afterEach(async () => {
    Logger.overrideLogger(false);
    jest.restoreAllMocks();
    for (const collMod of ['news-article', 'article-fingerprint']) {
      await h.connection.db!.command({ collMod, validator: {} });
    }
  });

  /** A feed served at `path` with `items`; returns its source id. */
  async function feed(path: string, items: string): Promise<string> {
    const url = `https://dupes.example.test/${path}.xml`;
    server.use(
      http.get(url, () =>
        HttpResponse.text(rss(items), {
          headers: { 'content-type': 'application/rss+xml' },
        }),
      ),
    );
    const source = await sources.create({
      publication_name: `Feed ${path}`,
      feed_url: url,
      type: 'rss-feed',
      country_code: 'GBR',
      category: 'general',
    });
    return String(source._id);
  }

  const load = (id: string) =>
    h.runJob(QueueName.LOAD_RSS_FEED, {
      rssFeedId: id,
    }) as Promise<LoadResult>;

  /** Runs `during` once, right after the feed's articles are inserted and before their fingerprints are written. */
  function afterNextInsert(during: () => Promise<unknown>) {
    const recorder = h.queues[QueueName.TRANSLATE_ARTICLE];
    const add = recorder.add.bind(recorder);
    jest
      .spyOn(recorder, 'add')
      .mockImplementationOnce(async (...args: Parameters<typeof add>) => {
        await during();
        return add(...args);
      });
  }

  const failedCount = async (id: string) =>
    (
      await h.connection
        .collection('state-machine-fetch-publication')
        .findOne({ publicationSourceId: new Types.ObjectId(id) })
    )?.articlesFailed as number | undefined;

  it('counts a lost insert race as duplicates, not failures', async () => {
    const shared =
      item('First shared story', 'https://dupes.example.test/race-1') +
      item('Second shared story', 'https://dupes.example.test/race-2');
    const winner = await feed('race-winner', shared);
    const loser = await feed(
      'race-loser',
      shared + item('Own story', 'https://dupes.example.test/race-3'),
    );

    // The loser checks the ledger after the winner inserted but before the
    // winner wrote its fingerprints, so its insert meets the unique index.
    let lost: LoadResult | undefined;
    afterNextInsert(async () => {
      lost = await load(loser);
    });
    const won = await load(winner);

    expect(won.result).toMatchObject({ newArticles: 2, errors: 0 });
    expect(lost!.result).toMatchObject({
      newArticles: 1,
      duplicates: 2,
      errors: 0,
    });
    expect(await failedCount(loser)).toBe(0);
    expect(lines.filter((l) => l.includes('non-duplicate'))).toEqual([]);
  });

  it('treats a fingerprint another writer already recorded as expected', async () => {
    const url = 'https://dupes.example.test/ledger-1';
    const id = await feed('ledger', item('Ledger story', url));
    afterNextInsert(() =>
      h.connection.collection('article-fingerprint').insertOne({
        article_url: url,
        createdAt: new Date(),
      }),
    );

    const result = await load(id);

    expect(result.result).toMatchObject({ newArticles: 1, errors: 0 });
    expect(lines.filter((l) => l.includes('non-duplicate'))).toEqual([]);
  });

  it('still reports a fingerprint write that fails for another reason', async () => {
    const id = await feed(
      'ledger-refused',
      item('Refused ledger story', 'https://dupes.example.test/ledger-2'),
    );
    await h.connection.db!.command({
      collMod: 'article-fingerprint',
      validator: {
        article_url: { $ne: 'https://dupes.example.test/ledger-2' },
      },
    });

    await load(id);

    expect(
      lines.filter((l) => l.includes('1 non-duplicate errors')),
    ).toHaveLength(1);
  });

  it('still counts an insert that fails for another reason as failed', async () => {
    const id = await feed(
      'refused',
      item('Accepted story', 'https://dupes.example.test/refused-1') +
        item('Refused story', 'https://dupes.example.test/refused-2'),
    );
    await h.connection.db!.command({
      collMod: 'news-article',
      validator: { title: { $ne: 'Refused story' } },
    });

    const result = await load(id);

    expect(result.result).toMatchObject({
      newArticles: 1,
      duplicates: 0,
      errors: 1,
    });
    expect(await failedCount(id)).toBe(1);
  });
});
