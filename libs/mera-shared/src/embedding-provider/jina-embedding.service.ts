import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EmbeddingProvider,
  type EmbeddingTask,
} from './embedding-provider.port';
import { embeddingDims } from './embedding-config';

type FetchFn = typeof fetch;

interface JinaEmbeddingResponse {
  data?: { index: number; embedding: number[] }[];
}

/**
 * Jina API adapter for {@link EmbeddingProvider} (Decision 2). Plain HTTPS via
 * `fetch` — no SDK in business logic. Same model prod runs today
 * (`jina-embeddings-v5-text-nano`, 768-dim, `retrieval.passage`), so vectors are
 * drop-in with the existing indexes.
 *
 * `fetch` is injected for testability. The batch size / in-flight tuning lives
 * in the MicroBatcher (embedding service); this adapter issues ONE request,
 * retrying transient failures (429/5xx/network) with exponential backoff —
 * same policy as the Gemini adapter, so rate spikes wait instead of DLQ-ing.
 */
@Injectable()
export class JinaEmbeddingService implements EmbeddingProvider {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly dims: number;
  private readonly model: string;
  private readonly task: string;
  private readonly fetchFn: FetchFn;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    config: ConfigService,
    fetchFn?: FetchFn,
    sleep?: (ms: number) => Promise<void>,
  ) {
    this.url = config.get<string>(
      'JINA_EMBEDDINGS_URL',
      'https://api.jina.ai/v1/embeddings',
    );
    this.apiKey = config.get<string>('JINA_API_KEY', '');
    this.dims = embeddingDims(config);
    this.model = config.get<string>(
      'JINA_MODEL',
      'jina-embeddings-v5-text-nano',
    );
    this.task = config.get<string>('JINA_TASK', 'retrieval.passage');
    this.fetchFn = fetchFn ?? fetch;
    this.maxRetries = config.get<number>('JINA_MAX_RETRIES', 5);
    this.backoffMs = config.get<number>('JINA_RETRY_BACKOFF_MS', 1500);
    this.sleep =
      sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  async embed(
    texts: string[],
    task: EmbeddingTask,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.apiKey) {
      throw new Error('JINA_API_KEY is not configured');
    }

    let attempt = 0;
    for (;;) {
      try {
        return await this.embedOnce(texts, task, signal);
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
    task: EmbeddingTask,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          task: task ?? this.task,
          input: texts,
          // Parity with the local ONNX pipeline (libs/mera-shared): it
          // L2-normalizes and truncates at the model's max sequence length.
          normalized: true,
          truncate: true,
        }),
        signal,
      });
    } catch (err) {
      // network-level failure (DNS/TLS/reset) — transient unless aborted
      const e = new Error(
        `Jina API network error: ${(err as Error).message}`,
      ) as Error & { transient?: boolean };
      e.transient = !signal?.aborted;
      throw e;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const e = new Error(
        `Jina API ${res.status}: ${body.slice(0, 300)}`,
      ) as Error & { transient?: boolean };
      e.transient = res.status === 429 || res.status >= 500;
      throw e;
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
      if (!Array.isArray(row.embedding) || row.embedding.length !== this.dims) {
        throw new Error(
          `Jina embedding for index ${row.index} is not ${this.dims}-dim`,
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
