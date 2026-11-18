import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EMBEDDING_PROVIDER,
  JinaEmbeddingService,
  FakeEmbeddingProvider,
} from '@mera/shared';
import { assertFakeAllowed, readText } from '@mera/shared/config/env-choice';
import { embeddingProvider } from '@mera/shared/embedding-provider/embedding-config';
import { OpenAiCompatibleEmbeddingService } from '@mera/shared/embedding-provider/openai-compatible-embedding.service';

/**
 * Composition root for the pipeline EmbeddingProvider. Mirrors the
 * graphql embedding-provider module: `EMBEDDING_PROVIDER=jina` (default) binds
 * the real Jina API adapter, `openai-compatible` binds any server that speaks
 * the OpenAI embeddings API (`EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`), `fake`
 * binds the deterministic offline provider for local CLI/tests so no real
 * Jina credits are spent.
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
      },
      inject: [ConfigService],
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class PipelineEmbeddingProviderModule {}
