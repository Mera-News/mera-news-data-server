import type { Type } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { http, HttpResponse } from 'msw';
import { OpenAiCompatibleEmbeddingService } from '../../../../libs/mera-shared/src/embedding-provider/openai-compatible-embedding.service';
import { PipelineEmbeddingProviderModule } from '../../../../apps/mera-server-async/src/modules/sync-news/pipeline-providers/embedding-provider.module';
import { EmbeddingProviderModule } from '../../../../libs/mera-news-core/src/embedding-provider/embedding-provider.module';
import { server } from '../../../harness/msw';

const URL_ = 'https://embeddings.example.test/v1/embeddings';
const noSleep = () => Promise.resolve();
const vector = (seed: number, length = 768) =>
  Array.from({ length }, () => seed);

const service = (env: Record<string, unknown> = {}) =>
  new OpenAiCompatibleEmbeddingService(
    {
      get: (key: string, fallback?: unknown) =>
        ({
          EMBEDDING_BASE_URL: 'https://embeddings.example.test/v1/',
          EMBEDDING_MODEL: 'fixture',
          EMBEDDING_API_KEY: '',
          ...env,
        })[key] ?? fallback,
    } as unknown as ConfigService,
    undefined,
    noSleep,
  );

describe('OpenAI-compatible embeddings adapter', () => {
  it('sends only model and input, with a bearer header only when a key is set', async () => {
    const seen: { auth: string | null; body: unknown }[] = [];
    server.use(
      http.post(URL_, async ({ request }) => {
        seen.push({
          auth: request.headers.get('authorization'),
          body: await request.json(),
        });
        // Reordered on purpose: the adapter aligns by `index`.
        return HttpResponse.json({
          data: [
            { index: 1, embedding: vector(2) },
            { index: 0, embedding: vector(1) },
          ],
        });
      }),
    );

    const withoutKey = await service().embed(['a', 'b'], 'retrieval.passage');
    const withKey = await service({ EMBEDDING_API_KEY: 'k' }).embed(
      ['a', 'b'],
      'text-matching',
    );

    expect(withoutKey).toEqual([vector(1), vector(2)]);
    expect(withKey).toEqual(withoutKey);
    expect(seen.map((s) => s.auth)).toEqual([null, 'Bearer k']);
    for (const s of seen) {
      expect(s.body).toEqual({ model: 'fixture', input: ['a', 'b'] });
    }
  });

  it('accepts vectors of EMBEDDING_DIMS and rejects any other length', async () => {
    server.use(
      http.post(URL_, () =>
        HttpResponse.json({ data: [{ index: 0, embedding: vector(1, 1024) }] }),
      ),
    );

    await expect(
      service({ EMBEDDING_DIMS: 1024 }).embed(['a'], 'retrieval.passage'),
    ).resolves.toEqual([vector(1, 1024)]);
    await expect(service().embed(['a'], 'retrieval.passage')).rejects.toThrow(
      'embedding for index 0 has 1024 values; EMBEDDING_DIMS is 768',
    );
  });

  it('retries a 429 and returns the vectors of the next answer', async () => {
    let calls = 0;
    server.use(
      http.post(URL_, () => {
        calls++;
        return calls === 1
          ? HttpResponse.text('slow down', { status: 429 })
          : HttpResponse.json({ data: [{ index: 0, embedding: vector(1) }] });
      }),
    );

    await expect(service().embed(['a'], 'retrieval.passage')).resolves.toEqual([
      vector(1),
    ]);
    expect(calls).toBe(2);
  });

  it('does not retry a 400', async () => {
    let calls = 0;
    server.use(
      http.post(URL_, () => {
        calls++;
        return HttpResponse.text('bad input', { status: 400 });
      }),
    );

    await expect(service().embed(['a'], 'retrieval.passage')).rejects.toThrow(
      'Embedding API 400: bad input',
    );
    expect(calls).toBe(1);
  });

  it('refuses to start without a base URL and a model', () => {
    expect(() => service({ EMBEDDING_MODEL: '' })).toThrow(
      'EMBEDDING_PROVIDER=openai-compatible needs EMBEDDING_BASE_URL and EMBEDDING_MODEL',
    );
  });
});

// The real composition modules, booted alone: a failed provider factory
// aborts a full app boot while its other providers are still starting.
const boot = (module: Type<unknown>) =>
  Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true }), module],
  }).compile();

describe.each([
  ['pipeline', PipelineEmbeddingProviderModule],
  ['query', EmbeddingProviderModule],
])('embedding provider boot refusals (%s binding)', (_name, module) => {
  const KEYS = [
    'EMBEDDING_PROVIDER',
    'EMBEDDING_MODEL',
    'ALLOW_FAKE_PROVIDERS',
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('refuses an unknown provider and names the allowed values', async () => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    await expect(boot(module)).rejects.toThrow(
      'is not one of: jina, openai-compatible, fake',
    );
  });

  it('refuses a model name with the jina provider', async () => {
    process.env.EMBEDDING_PROVIDER = 'jina';
    process.env.EMBEDDING_MODEL = 'x';
    await expect(boot(module)).rejects.toThrow(
      'are read only with EMBEDDING_PROVIDER=openai-compatible',
    );
  });

  it('refuses the fake provider in production without the allowance', async () => {
    process.env.EMBEDDING_PROVIDER = 'fake';
    process.env.ALLOW_FAKE_PROVIDERS = '';
    await expect(boot(module)).rejects.toThrow('ALLOW_FAKE_PROVIDERS=true');
  });
});
