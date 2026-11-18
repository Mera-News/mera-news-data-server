import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { TopicScoresCommand } from '../../../apps/mera-scripts/src/commands/topic-scores/topic-scores.command';
import { TopicScoresModule } from '../../../apps/mera-scripts/src/commands/topic-scores/topic-scores.module';
import { installAtlasSearchFake } from '../../harness/atlas-search-fake';
import {
  seedArticle,
  seedSource,
  vectorWithScore,
} from '../retrieval/support/fixtures';

describe('topic-scores command', () => {
  let app: INestApplicationContext;
  let connection: Connection;
  let fake: ReturnType<typeof installAtlasSearchFake>;
  let lines: string[];

  beforeAll(async () => {
    fake = installAtlasSearchFake();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true }),
        MongooseModule.forRoot(process.env.MONGODB_URI!),
        TopicScoresModule,
      ],
    }).compile();
    app = await moduleRef.init();
    connection = app.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await app?.close();
    fake.uninstall();
  });

  beforeEach(async () => {
    for (const c of await connection.db!.collections()) await c.deleteMany({});
    lines = [];
    jest.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('prints the score of a seeded article and writes no topic', async () => {
    const topic = 'harbour dredging';
    const source = await seedSource(connection);
    await seedArticle(connection, {
      source,
      vector: vectorWithScore(topic, 0.9),
    });

    await app.get(TopicScoresCommand).run([topic]);

    expect(lines[0]).toMatch(
      /^"harbour dredging": top scores 0\.900 ; 1 of 10 at or above VECTOR_MIN_SCORE 0\.78$/,
    );
    expect(lines[1]).toMatch(/^Pick VECTOR_MIN_SCORE between/);
    expect(await connection.collection('user-topic').countDocuments()).toBe(0);
    expect(fake.calls.at(-1)).toMatchObject({ limit: 10, numCandidates: 200 });
  });
});
