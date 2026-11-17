import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigModule } from '@nestjs/config';
import {
  MongooseModule,
  getConnectionToken,
  getModelToken,
} from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { Connection, Model } from 'mongoose';
import { LoadRssCommand } from '../../../../apps/mera-scripts/src/commands/load-rss/load-rss.command';
import { LoadRssModule } from '../../../../apps/mera-scripts/src/commands/load-rss/load-rss.module';
import { NewsPublisher } from '@mera/models/models/news-publisher.model';
import { PublicationSource } from '@mera/models/models/publication-source.model';

// Keyed alpha-3, as the real feed list is; the import stores the key verbatim.
const SEED = {
  GBR: [
    {
      publication_name: 'Harbour Gazette',
      publication_website_uri: 'https://harbour-gazette.example.test',
      publication_subscription_uri: null,
      publication_rss_feed_uris: [
        {
          uri: 'https://harbour-gazette.example.test/rss/front.xml',
          category: 'general_news',
        },
        {
          uri: 'https://harbour-gazette.example.test/rss/sport.xml',
          category: 'sports',
          gated: true,
        },
      ],
    },
  ],
  IND: [
    {
      publication_name: 'Lantern Daily',
      publication_website_uri: 'https://lantern-daily.example.test',
      publication_rss_feed_uris: [
        { uri: 'https://lantern-daily.example.test/feed.xml', is_valid: false },
      ],
    },
  ],
};

describe('load-rss command', () => {
  let app: INestApplicationContext;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'load-rss-'));
    mkdirSync(join(dir, 'apps/mera-scripts/seed-data'), { recursive: true });
    writeFileSync(
      join(dir, 'apps/mera-scripts/seed-data/active-feeds-auto-generated.json'),
      JSON.stringify(SEED),
    );

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        MongooseModule.forRoot(process.env.MONGODB_URI!),
        LoadRssModule,
      ],
    }).compile();
    app = await moduleRef.init();
    // The worker database is shared with other test files: start empty.
    const db = app.get<Connection>(getConnectionToken()).db!;
    for (const c of await db.collections()) await c.deleteMany({});
  });

  afterAll(async () => {
    await app?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('imports publishers and their feeds from the seed', async () => {
    // The command reads <cwd>/apps/mera-scripts/seed-data/..., so it runs from
    // the temp root. The process cwd is shared by every test file in this
    // worker, so it is restored even when the run throws.
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      await app.get(LoadRssCommand).run([], {});
    } finally {
      process.chdir(cwd);
    }

    const publishers = app.get<Model<NewsPublisher>>(
      getModelToken(NewsPublisher.name),
      { strict: false },
    );
    const sources = app.get<Model<PublicationSource>>(
      getModelToken(PublicationSource.name),
      { strict: false },
    );

    const harbour = await publishers
      .findOne({ name: 'Harbour Gazette' })
      .lean();
    expect(harbour).toMatchObject({
      country_code: 'GBR',
      website_url: 'https://harbour-gazette.example.test',
      subscription_uri: null,
      is_active: true,
    });
    expect(await publishers.countDocuments()).toBe(2);

    const feeds = await sources
      .find({ newsPublisherId: harbour!._id })
      .sort({ feed_url: 1 })
      .lean();
    expect(feeds.map((f) => [f.feed_url, f.category, f.gated])).toEqual([
      [
        'https://harbour-gazette.example.test/rss/front.xml',
        'general_news',
        false,
      ],
      ['https://harbour-gazette.example.test/rss/sport.xml', 'sports', true],
    ]);
    expect(feeds[0]).toMatchObject({
      type: 'rss-feed',
      country_code: 'GBR',
      is_active_user: true,
    });

    const lantern = await sources
      .findOne({ feed_url: 'https://lantern-daily.example.test/feed.xml' })
      .lean();
    expect(lantern).toMatchObject({
      is_active_codegen: false,
      codegen_status: 'invalid',
    });
  });
});
