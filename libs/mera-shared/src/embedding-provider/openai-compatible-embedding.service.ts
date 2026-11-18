import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readText } from '../config/env-choice';
import { embeddingDims } from './embedding-config';
import {
  EmbeddingProvider,
  type EmbeddingTask,
} from './embedding-provider.port';

type FetchFn = typeof fetch;

interface EmbeddingsResponse {
  data?: { index: number; embedding: number[] }[];
}

/**
 * Adapter for any server that speaks the OpenAI `/embeddings` API (a hosted
 * service, vLLM, Ollama, llama.cpp). It sends only `model` and `input`, so the
 * task of the call is ignored and every text gets the same kind of vector.
 * Each vector must have `EMBEDDING_DIMS` values. Transient failures (network,
 * 429, 5xx) are retried with exponential backoff, like the Jina adapter.
 * `fetch` and `sleep` are injected for tests.
 */
@Injectable()
export class OpenAiCompatibleEmbeddingService implements EmbeddingProvider {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly dims: number;
  private readonly fetchFn: FetchFn;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    config: ConfigService,
    fetchFn?: FetchFn,
    sleep?: (ms: number) => Promise<void>,
  ) {
    const base = readText(config, 'EMBEDDING_BASE_URL').replace(/\/+$/, '');
    this.model = readText(config, 'EMBEDDING_MODEL');
    if (!base || !this.model) {
      throw new Error(
        'EMBEDDING_PROVIDER=openai-compatible needs EMBEDDING_BASE_URL and EMBEDDING_MODEL',
      );
    }
    this.url = `${base}/embeddings`;
    this.apiKey = readText(config, 'EMBEDDING_API_KEY');
    this.dims = embeddingDims(config);
    this.fetchFn = fetchFn ?? fetch;
    this.maxRetries = config.get<number>('EMBEDDING_MAX_RETRIES', 5);
    this.backoffMs = config.get<number>('EMBEDDING_RETRY_BACKOFF_MS', 1500);
    this.sleep =
      sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  async embed(
    texts: string[],
    _task: EmbeddingTask,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    let attempt = 0;
    for (;;) {
      try {
        return await this.embedOnce(texts, signal);
      } catch (err) {
        const transient =
          !signal?.aborted &&
          ((err as { transient?: boolean }).transient ?? false);
        if (transient && attempt < this.maxRetries) {
          attempt++;
          await this.sleep(this.backoffMs * Math.pow(2, attempt - 1));
          continue;
        }
        throw err;
      }
    }
  }

  private async embedOnce(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.model, input: texts }),
        signal,
      });
    } catch (err) {
      const e = new Error(
        `Embedding API network error: ${(err as Error).message}`,
      ) as Error & { transient?: boolean };
      e.transient = !signal?.aborted;
      throw e;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(
        `Embedding API ${res.status}: ${body.slice(0, 300)}`,
      ) as Error & { transient?: boolean };
      e.transient = res.status === 429 || res.status >= 500;
      throw e;
    }

    const json = (await res.json()) as EmbeddingsResponse;
    const data = json.data ?? [];
    if (data.length !== texts.length) {
      throw new Error(
        `Embedding API returned ${data.length} embeddings for ${texts.length} inputs`,
      );
    }

    // Re-order by `index` so alignment holds even if the API reorders.
    const out = new Array<number[]>(texts.length);
    for (const row of data) {
      out[row.index] = row.embedding;
    }
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) throw new Error(`Embedding API response missing index ${i}`);
      if (!Array.isArray(out[i]) || out[i].length !== this.dims) {
        throw new Error(
          `embedding for index ${i} has ${out[i]?.length} values; EMBEDDING_DIMS is ${this.dims}`,
        );
      }
    }
    return out;
  }
}
