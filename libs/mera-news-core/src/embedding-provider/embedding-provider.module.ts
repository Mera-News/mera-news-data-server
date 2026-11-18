import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertFakeAllowed, readText } from '@mera/shared/config/env-choice';
import { embeddingProvider } from '@mera/shared/embedding-provider/embedding-config';
import { OpenAiCompatibleEmbeddingService } from '@mera/shared/embedding-provider/openai-compatible-embedding.service';
import { EMBEDDING_PROVIDER } from './embedding-provider.port';
import { JinaQueryEmbeddingService } from './jina-query-embedding.service';
import { FakeEmbeddingProvider } from './fake-embedding.provider';

/**
 * Composition root for the inline (request-scoped) query-embedding provider.
 * `EMBEDDING_PROVIDER=jina|openai-compatible|fake` binds the adapter: `fake`
 * for local CLI verification / tests against the docker-compose stack so no
 * real Jina credits are spent, `openai-compatible` for any server that speaks
 * the OpenAI embeddings API (mirrors the pipeline embedding module's switch).
 */
@Global()
@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: (config: ConfigService) => {
        switch (embeddingProvider(config)) {
          case 'fake':
            assertFakeAllowed(config, 'EMBEDDING_PROVIDER');
            return new FakeEmbeddingProvider();
          case 'openai-compatible': {
            const svc = new OpenAiCompatibleEmbeddingService(config);
            return {
              embed: (texts: string[], signal?: AbortSignal) =>
                svc.embed(texts, 'retrieval.query', signal),
            };
          }
          case 'jina':
            if (
              readText(config, 'EMBEDDING_BASE_URL') ||
              readText(config, 'EMBEDDING_MODEL')
            ) {
              throw new Error(
                'EMBEDDING_BASE_URL and EMBEDDING_MODEL are read only with EMBEDDING_PROVIDER=openai-compatible; unset them or change the provider',
              );
            }
            return new JinaQueryEmbeddingService(config);
        }
      },
      inject: [ConfigService],
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingProviderModule {}
