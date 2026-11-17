import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EMBEDDING_PROVIDER } from './embedding-provider.port';
import { JinaQueryEmbeddingService } from './jina-query-embedding.service';
import { FakeEmbeddingProvider } from './fake-embedding.provider';

/**
 * Composition root for the inline (request-scoped) query-embedding provider.
 * `EMBEDDING_PROVIDER=jina|fake` binds the adapter — `fake` for local CLI
 * verification / tests against the docker-compose stack so no real Jina
 * credits are spent (mirrors the jobs-v3 embedding module's env switch).
 */
@Global()
@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: (config: ConfigService) =>
        config.get<string>('EMBEDDING_PROVIDER', 'jina') === 'fake'
          ? new FakeEmbeddingProvider()
          : new JinaQueryEmbeddingService(config),
      inject: [ConfigService],
    },
  ],
  exports: [EMBEDDING_PROVIDER],
})
export class EmbeddingProviderModule {}
