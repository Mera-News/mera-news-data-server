import { ConfigService } from '@nestjs/config';
import type { Db } from 'mongodb';
import { assertFakeAllowed, readText } from '../config/env-choice';
import { embeddingProvider } from './embedding-config';
import { checkEmbeddingMeta } from './embedding-meta';
import type { EmbeddingProvider } from './embedding-provider.port';
import { FakeEmbeddingProvider } from './fake-embedding.provider';
import { JinaEmbeddingService } from './jina-embedding.service';
import { OpenAiCompatibleEmbeddingService } from './openai-compatible-embedding.service';

/**
 * The task-aware embedder the pipeline writes article and topic vectors with.
 * `EMBEDDING_PROVIDER=jina` (default) binds the Jina API adapter,
 * `openai-compatible` any server that speaks the OpenAI embeddings API
 * (`EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`), `fake` the deterministic offline
 * provider, refused unless `ALLOW_FAKE_PROVIDERS=true`.
 */
function buildEmbedder(config: ConfigService): EmbeddingProvider {
  switch (embeddingProvider(config)) {
    case 'fake':
      assertFakeAllowed(config, 'EMBEDDING_PROVIDER');
      return new FakeEmbeddingProvider();
    case 'openai-compatible':
      return new OpenAiCompatibleEmbeddingService(config);
    case 'jina':
      if (
        readText(config, 'EMBEDDING_BASE_URL') ||
        readText(config, 'EMBEDDING_MODEL')
      ) {
        throw new Error(
          'EMBEDDING_BASE_URL and EMBEDDING_MODEL are read only with EMBEDDING_PROVIDER=openai-compatible; unset them or change the provider',
        );
      }
      return new JinaEmbeddingService(config);
  }
}

/**
 * The pipeline embedder, returned only after the database's embedding meta document
 * agrees with the configuration (and recorded when the database has none).
 */
export async function pipelineEmbeddingProvider(
  config: ConfigService,
  connection: { db?: Db },
): Promise<EmbeddingProvider> {
  const embedder = buildEmbedder(config);
  await checkEmbeddingMeta(connection.db!, config, { write: true });
  return embedder;
}
