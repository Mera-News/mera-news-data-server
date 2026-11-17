import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EmbeddingProvider,
  type EmbeddingTask,
} from './embedding-provider.port';

const EMBED_DIMS = 768;

type FetchFn = typeof fetch;

interface JinaEmbeddingResponse {
  data?: { index: number; embedding: number[] }[];
}

/**
 * Jina API adapter for {@link EmbeddingProvider}, fixed to the `retrieval.query`
 * task — this is the
 * inline, request-scoped embedding call used by the topic-add mutation and
 * the Flow v2 vector-search fallback, not a batch job. Plain `fetch`, no SDK
 * in business logic; `fetch` is injected for testability.
 */
@Injectable()
export class JinaQueryEmbeddingService implements EmbeddingProvider {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetchFn: FetchFn;

  constructor(config: ConfigService, fetchFn?: FetchFn) {
    this.url = config.get<string>(
      'JINA_EMBEDDINGS_URL',
      'https://api.jina.ai/v1/embeddings',
    );
    this.apiKey = config.get<string>('JINA_API_KEY', '');
    this.model = config.get<string>(
      'JINA_MODEL',
      'jina-embeddings-v5-text-nano',
    );
    this.fetchFn = fetchFn ?? fetch;
  }

  async embed(
    texts: string[],
    signal?: AbortSignal,
    task: EmbeddingTask = 'retrieval.query',
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.apiKey) {
      throw new Error('JINA_API_KEY is not configured');
    }

    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        task,
        input: texts,
        // Parity with the local ONNX pipeline (libs/mera-shared): it
        // L2-normalizes and truncates at the model's max sequence length.
        normalized: true,
        truncate: true,
      }),
      signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Jina API ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as JinaEmbeddingResponse;
    const data = json.data ?? [];
    if (data.length !== texts.length) {
      throw new Error(
        `Jina returned ${data.length} embeddings for ${texts.length} inputs`,
      );
    }

    // Re-order by `index` so alignment holds even if the API reorders.
    const out = new Array<number[]>(texts.length);
    for (const row of data) {
      if (
        !Array.isArray(row.embedding) ||
        row.embedding.length !== EMBED_DIMS
      ) {
        throw new Error(
          `Jina embedding for index ${row.index} is not ${EMBED_DIMS}-dim`,
        );
      }
      out[row.index] = row.embedding;
    }
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) throw new Error(`Jina response missing index ${i}`);
    }
    return out;
  }
}
