import { ConfigService } from '@nestjs/config';
import { http, HttpResponse } from 'msw';
import { JinaEmbeddingService } from '../../../../libs/mera-shared/src/embedding-provider/jina-embedding.service';
import { server } from '../../../harness/msw';

const URL_ = 'https://api.jina.ai/v1/embeddings';
const config = {
  get: (key: string, fallback?: unknown) =>
    ({ JINA_API_KEY: 'test-key', JINA_MAX_RETRIES: 3 })[key] ?? fallback,
} as unknown as ConfigService;
const vector = (seed: number) => Array.from({ length: 768 }, () => seed);

describe('Jina embeddings adapter', () => {
  it('sends the documented request and returns vectors in input order', async () => {
    const seen: { auth: string | null; body: Record<string, unknown> }[] = [];
    server.use(
      http.post(URL_, async ({ request }) => {
        seen.push({
          auth: request.headers.get('authorization'),
          body: (await request.json()) as Record<string, unknown>,
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

    const out = await new JinaEmbeddingService(config).embed(
      ['alpha', 'beta'],
      'retrieval.passage',
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe('Bearer test-key');
    expect(seen[0].body).toEqual({
      model: 'jina-embeddings-v5-text-nano',
      task: 'retrieval.passage',
      input: ['alpha', 'beta'],
      normalized: true,
      truncate: true,
    });
    expect(out).toEqual([vector(1), vector(2)]);
    expect(out[0]).toHaveLength(768);
  });

  it('surfaces a 403 insufficient-balance answer as a non-transient error without retrying', async () => {
    let calls = 0;
    server.use(
      http.post(URL_, () => {
        calls++;
        return HttpResponse.json(
          { detail: 'Insufficient balance' },
          { status: 403 },
        );
      }),
    );

    const err = await new JinaEmbeddingService(config)
      .embed(['alpha'], 'retrieval.passage')
      .catch((e: Error & { transient?: boolean }) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /^Jina API 403: .*Insufficient balance/,
    );
    expect((err as { transient?: boolean }).transient).toBe(false);
    expect(calls).toBe(1);
  });
});
