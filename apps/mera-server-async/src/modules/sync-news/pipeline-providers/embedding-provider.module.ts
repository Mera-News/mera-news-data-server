import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMBEDDING_PROVIDER } from '@mera/shared';
import { pipelineEmbeddingProvider } from '@mera/shared/embedding-provider/pipeline-embedding-provider';

/**
 * Composition root for the pipeline EmbeddingProvider; the provider switch is
 * `pipelineEmbeddingProvider`. Mirrors the news API's query-embedding module.
 */
@Global()
@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: pipelineEmbeddingProvider,
      inject: [ConfigService],
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class PipelineEmbeddingProviderModule {}
