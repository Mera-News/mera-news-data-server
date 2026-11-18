import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { StatusCommand } from '../../../apps/mera-scripts/src/commands/status/status.command';
import { StatusModule } from '../../../apps/mera-scripts/src/commands/status/status.module';
import {
  seedArticle,
  seedSource,
  vectorWithScore,
} from '../retrieval/support/fixtures';

describe('status command', () => {
  let app: INestApplicationContext;
  let connection: Connection;
  let lines: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        MongooseModule.forRoot(process.env.MONGODB_URI!),
        StatusModule,
      ],
    }).compile();
    app = await moduleRef.init();
    connection = app.get<Connection>(getConnectionToken());
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    for (const c of await connection.db!.collections()) await c.deleteMany({});
    lines = [];
    jest.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.exitCode = undefined;
  });

  const run = (check?: string) => app.get(StatusCommand).run([], { check });

  it('prints zeros on an empty database and fails the embedded check', async () => {
    await run('embedded');

    expect(lines).toEqual([
      'feeds: 0 active, 0 inactive, 0 refused',
      'articles in the last 48 hours: 0 stored, 0 embedded',
      'clusters: 0',
      'topics: 0, linked to clusters: 0',
      'last topic link run: none',
      'headline editions: 0, newest never',
      'check failed: nothing at the embedded stage yet',
    ]);
    expect(process.exitCode).toBe(1);
  });

  it('passes the embedded check once an embedded article is stored', async () => {
    const source = await seedSource(connection);
    await seedArticle(connection, {
      source,
      vector: vectorWithScore('harbour tides', 0.9),
    });
    await seedArticle(connection, { source });

    await run('embedded');

    expect(lines).toContain('feeds: 1 active, 0 inactive, 0 refused');
    expect(lines).toContain(
      'articles in the last 48 hours: 2 stored, 1 embedded',
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('names the four stages for an unknown one', async () => {
    await expect(run('nonsense')).rejects.toThrow(
      'embedded, clustered, linked, edition',
    );
  });
});
