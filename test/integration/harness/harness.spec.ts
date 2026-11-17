import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import axios from 'axios';
import { http, HttpResponse } from 'msw';
import request from 'supertest';
import { bootAsyncApp, type Harness } from '../../harness/boot';
import { blankEnv } from '../../harness/env';
import { server, takeUnhandled } from '../../harness/msw';

describe('harness: env guard', () => {
  let root: string;
  let saved: NodeJS.ProcessEnv;
  const KEY = 'HARNESS_CANARY_SECRET';

  beforeEach(() => {
    saved = { ...process.env };
    root = mkdtempSync(join(tmpdir(), 'env-guard-'));
    mkdirSync(join(root, 'apps/mera-server-async'), { recursive: true });
    writeFileSync(
      join(root, 'apps/mera-server-async/.env'),
      `${KEY}=from-a-prod-env-file\nMONGODB_URI=mongodb+srv://prod.example.net/db\n`,
    );
    writeFileSync(join(root, '.env.example'), 'EXAMPLE_ONLY=1\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.env = saved;
  });

  const resolveFrom = async (envFilePath: string) => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ envFilePath })],
    }).compile();
    return moduleRef.get(ConfigService).get<string>(KEY);
  };

  it('a planted .env value reaches ConfigService without the guard', async () => {
    delete process.env[KEY];
    expect(await resolveFrom(join(root, 'apps/mera-server-async/.env'))).toBe(
      'from-a-prod-env-file',
    );
  });

  it('blanks every key of every .env file, and skips .env.example', async () => {
    delete process.env[KEY];
    const env: NodeJS.ProcessEnv = {};
    expect(blankEnv(root, env).sort()).toEqual(['MONGODB_URI', KEY].sort());

    blankEnv(root);
    expect(await resolveFrom(join(root, 'apps/mera-server-async/.env'))).toBe('');
  });

  it('points the app at the in-memory replica set, never at a .env value', () => {
    expect(process.env.MONGODB_URI).toMatch(/^mongodb:\/\/127\.0\.0\.1:\d+\/mera-test-\d+/);
  });
});

describe('harness: outbound requests', () => {
  it('serves a handled request', async () => {
    server.use(http.get('https://feeds.example.test/ok', () => HttpResponse.text('ok')));
    const res = await axios.get('https://feeds.example.test/ok');
    expect(res.data).toBe('ok');
  });

  it('refuses and records an unhandled request from fetch and axios', async () => {
    await expect(fetch('https://unhandled.example.test/a')).rejects.toThrow();
    await expect(axios.get('https://unhandled.example.test/b')).rejects.toThrow();
    // Taken here so this test passes; any other test fails on them in afterEach.
    expect(takeUnhandled()).toEqual([
      'GET https://unhandled.example.test/a',
      'GET https://unhandled.example.test/b',
    ]);
  });
});

describe('harness: async app boot', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await bootAsyncApp();
  });

  afterAll(() => harness?.close());

  it('boots with every queue recorded and answers /health', async () => {
    expect(Object.keys(harness.queues)).toHaveLength(11);
    const res = await request(harness.app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
  });
});
