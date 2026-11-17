import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EMBEDDING_PROVIDER,
  JinaEmbeddingService,
  FakeEmbeddingProvider,
} from '@mera/shared';

/**
 * Composition root for the pipeline EmbeddingProvider. Mirrors the
 * graphql embedding-provider module: `EMBEDDING_PROVIDER=jina` (default) binds
 * the real Jina API adapter, `fake` binds the deterministic offline provider for
 * local CLI/tests so no real Jina credits are spent.
 */
@Global()
@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: (config: ConfigService) =>
        config.get<string>('EMBEDDING_PROVIDER', 'jina') === 'fake'
          ? new FakeEmbeddingProvider()
          : new JinaEmbeddingService(config),
      inject: [ConfigService],
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class PipelineEmbeddingProviderModule {}
