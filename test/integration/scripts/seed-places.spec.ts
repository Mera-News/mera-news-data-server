import { ConfigModule } from '@nestjs/config';
import { MongooseModule, getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Logger, type INestApplicationContext } from '@nestjs/common';
import type { Connection } from 'mongoose';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedPlacesCommand } from '../../../apps/mera-scripts/src/commands/seed-places/seed-places.command';
import { SeedPlacesModule } from '../../../apps/mera-scripts/src/commands/seed-places/seed-places.module';

const SAMPLE = join(__dirname, '../../fixtures/places/cities-sample.txt');
const ATTRIBUTION =
  'Place names from GeoNames (https://www.geonames.org), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).';

describe('seed-places command', () => {
  let app: INestApplicationContext;
  let connection: Connection;
  let lines: string[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        MongooseModule.forRoot(process.env.MONGODB_URI!),
        SeedPlacesModule,
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
    const push = (m: unknown) => lines.push(String(m));
    Logger.overrideLogger({
      log: push,
      error: push,
      warn: push,
      debug: push,
      verbose: push,
    });
    jest.spyOn(console, 'log').mockImplementation(push);
  });

  afterEach(() => {
    Logger.overrideLogger(false);
    jest.restoreAllMocks();
  });

  const run = (options: Record<string, unknown>) =>
    app.get(SeedPlacesCommand).run([], options);
  const places = () => connection.collection('places');

  it('upserts the sample rows with search keys built', async () => {
    await run({ file: SAMPLE });

    expect(await places().countDocuments()).toBe(4);
    const row = await places().findOne({ normalized: 'testford' });
    expect(row).toMatchObject({
      city: 'Testford',
      countryCode: 'XX',
      population: 200000,
      latitude: 11.25,
    });
    expect(row!.search_keys).toEqual(
      expect.arrayContaining(['testford', 'testford-on-sea', 'port testford']),
    );
  });

  it('is safe to run twice', async () => {
    await run({ file: SAMPLE });
    const first = await places().find({}).sort({ normalized: 1 }).toArray();
    await run({ file: SAMPLE });
    const second = await places().find({}).sort({ normalized: 1 }).toArray();

    expect(second).toEqual(first);
  });

  it('writes nothing on --dry-run', async () => {
    await run({ file: SAMPLE, dryRun: true });
    expect(await places().countDocuments()).toBe(0);
  });

  it('honours --limit', async () => {
    await run({ file: SAMPLE, limit: 2 });
    expect(await places().countDocuments()).toBe(2);
  });

  it('fails on a missing file and writes nothing', async () => {
    await expect(run({ file: '/nonexistent/cities.txt' })).rejects.toThrow();
    await expect(run({})).rejects.toThrow(/--file/);
    expect(await places().countDocuments()).toBe(0);
  });

  it('skips rows that are not in the file format and counts them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'places-'));
    const bad = join(dir, 'bad.txt');
    writeFileSync(bad, 'not a places file\n\n1\t\t\t\n');
    await run({ file: bad });

    expect(await places().countDocuments()).toBe(0);
    expect(lines.join('\n')).toMatch(/parsed=0 skipped=2/);
  });

  it('prints counts and the attribution, and no place text', async () => {
    await run({ file: SAMPLE });
    const out = lines.join('\n');

    expect(out).toMatch(/parsed=4 skipped=0/);
    expect(out.split(ATTRIBUTION).length - 1).toBe(1);
    for (const text of ['Testville', 'Testford', 'Sampleton', 'Testbr'])
      expect(out.includes(text)).toBe(false);
  });
});
