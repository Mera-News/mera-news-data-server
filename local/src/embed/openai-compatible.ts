import { EmbedError, batches, normalize, type Embedder } from './embedder.ts';

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  model: string;
  dims: number;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  batchSize?: number;
}

export function createOpenAiCompatibleEmbedder(opts: OpenAiCompatibleOptions): Embedder {
  const { baseUrl, model, dims, apiKey, fetch = globalThis.fetch, batchSize = 32 } = opts;
  const url = `${baseUrl.replace(/\/+$/, '')}/embeddings`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  async function embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (const input of batches(texts, batchSize)) {
      let res: Response;
      try {
        res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model, input }) });
      } catch {
        throw new EmbedError('embed_endpoint_unreachable', `The embedding endpoint at ${url} could not be reached.`, 'Check the base URL and that the server is running.');
      }
      if (!res.ok) {
        throw new EmbedError('embed_endpoint_failed', `The embedding endpoint at ${url} answered with status ${res.status}.`, 'Check the base URL, the model name and the API key.');
      }
      const body = (await res.json().catch(() => null)) as { data?: { index?: number; embedding?: number[] }[] } | null;
      const data = body?.data;
      if (!Array.isArray(data) || data.length !== input.length) {
        throw new EmbedError('embed_bad_response', `Expected ${input.length} vectors but the endpoint returned ${Array.isArray(data) ? data.length : 'none'}.`, 'Check that the endpoint is OpenAI-compatible and serves the named model.');
      }
      // Servers may reorder; index says which input a vector belongs to.
      const ordered = data.every((d) => typeof d.index === 'number') ? [...data].sort((a, b) => a.index! - b.index!) : data;
      for (const d of ordered) {
        if (!Array.isArray(d.embedding) || d.embedding.length !== dims) {
          throw new EmbedError('embed_dims_mismatch', `Expected vectors of ${dims} dimensions but the endpoint returned ${Array.isArray(d.embedding) ? d.embedding.length : 'none'}.`, 'Set the dimensions to match the model the endpoint serves.');
        }
        out.push(normalize(d.embedding));
      }
    }
    return out;
  }

  return {
    model,
    dims,
    embedPassages: embed,
    embedQuery: async (text) => (await embed([text]))[0]!,
  };
}
