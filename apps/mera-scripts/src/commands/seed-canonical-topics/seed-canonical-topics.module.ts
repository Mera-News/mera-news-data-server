import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { EMBEDDING_PROVIDER } from '@mera/shared';
import { pipelineEmbeddingProvider } from '@mera/shared/embedding-provider/pipeline-embedding-provider';
import { SeedCanonicalTopicsCommand } from './seed-canonical-topics.command';
import { SeedCanonicalTopicsService } from './seed-canonical-topics.service';

// Bound here, not globally: the news API's query embedder is global under the
// same token, and other commands in this app inject that one.
@Module({
  providers: [
    {
      provide: EMBEDDING_PROVIDER,
      useFactory: pipelineEmbeddingProvider,
      inject: [ConfigService, getConnectionToken()],
    },
    SeedCanonicalTopicsCommand,
    SeedCanonicalTopicsService,
  ],
})
export class SeedCanonicalTopicsModule {}
